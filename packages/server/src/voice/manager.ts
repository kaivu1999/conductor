/**
 * Owns every live voice session server-side: mints it, attaches the sideband, keeps the
 * transcript, and answers GPT-Live's client delegations. The browser only carries audio,
 * so each action has exactly one owner (here).
 */
import { errorMessage, type Logger } from '../supervisor/errors.ts';
import { createLiveSession, type LiveSession, type VoiceConfig } from './live.ts';
import { attachSideband, nodeWebSocket, type LiveEvent, type Sideband, type WebSocketFactory } from './sideband.ts';
import { Transcript } from './transcript.ts';
import { composeNotices, NoticeGate, type Notice } from './notifier.ts';
import type { Run } from '@conductor/shared';

export interface DelegationRequest {
  sessionId: string;
  delegationId: string;
  /** Session-relative ms at which GPT-Live delegated. */
  offsetMs: number;
  transcript: Transcript;
}

/** Does the work behind the voice session. */
export interface VoiceBackend {
  /** A voice session opened (warm up here). The transcript object lives as long as the session. */
  open?(sessionId: string, transcript: Transcript): void;
  /** Handle one delegation; returns a short, speakable result. */
  delegate(req: DelegationRequest): Promise<string>;
  /** The voice session ended. */
  close?(sessionId: string): void;
}

/** Stand-in backend without an orchestrator: repeats back what it heard. */
export const echoBackend: VoiceBackend = {
  async delegate({ transcript }) {
    const heard = transcript.lastUser()?.text.trim();
    return heard
      ? `Backend stub: I heard "${heard}". The task tools aren't connected yet.`
      : "Backend stub: I didn't catch the request. The task tools aren't connected yet.";
  },
};

export interface VoiceManagerDeps {
  config: VoiceConfig;
  fetch?: typeof fetch;
  connect?: WebSocketFactory;
  backend?: VoiceBackend;
  /** Wait before reading the transcript: the user's last words can arrive after the delegation. */
  settleMs?: number;
  closeTimeoutMs?: number;
  /** Quiet time before a notice is spoken. */
  silenceMs?: number;
  /** How often queued notices are checked. */
  noticeTickMs?: number;
  /** Tasks that already need the user when a session opens (Conductor mentions them first). */
  initialNotices?: () => Notice[];
  /** Hold notices this long after a session opens, while its audio connects. */
  startDelayMs?: number;
  log?: Logger;
}

export interface VoiceSessionState {
  id: string;
  transcript: Transcript;
  sideband: Sideband;
}

export interface VoiceManager {
  open(offerSdp: string): Promise<LiveSession>;
  get(sessionId: string): VoiceSessionState | undefined;
  /** A task started needing the user: tell every open session, softly. */
  notify(notice: Notice): void;
  /** Any run changed (drops queued notices that no longer apply). */
  runChanged(run: Run): void;
  /** Gracefully close every session (conductor shutdown). */
  closeAll(): Promise<void>;
}

/** Appended `content` is capped at 500 tokens; stay well under by characters. */
const MAX_CONTENT_CHARS = 1500;
const clip = (s: string) => (s.length > MAX_CONTENT_CHARS ? `${s.slice(0, MAX_CONTENT_CHARS - 1)}…` : s);

export const voiceLog: Logger = {
  info: (m, ...r) => console.log(`[voice] ${m}`, ...r),
  warn: (m, ...r) => console.warn(`[voice] ${m}`, ...r),
  error: (m, ...r) => console.error(`[voice] ${m}`, ...r),
};

export function createVoiceManager(deps: VoiceManagerDeps): VoiceManager {
  const { config } = deps;
  const backend = deps.backend ?? echoBackend;
  const settleMs = deps.settleMs ?? 400;
  const closeTimeoutMs = deps.closeTimeoutMs ?? 3000;
  const log = deps.log ?? voiceLog;
  const sessions = new Map<string, VoiceSessionState & { gate: NoticeGate; closed: Promise<void>; markClosed(): void }>();
  let eventSeq = 0;
  const eventId = (prefix: string) => `${prefix}_${++eventSeq}`;

  function attach(id: string): void {
    const transcript = new Transcript();
    let markClosed!: () => void;
    const closed = new Promise<void>((r) => { markClosed = r; });
    const gate = new NoticeGate((notices) => {
      const { commentary, thinking } = composeNotices(notices);
      log.info(`${id}: notice → ${notices.map((n) => `${n.runId}:${n.state}`).join(', ')}`);
      sideband.send({ type: 'session.thinking.append', event_id: eventId('notice_ctx'), delegation_id: null, content: clip(thinking) });
      sideband.send({ type: 'session.commentary.append', event_id: eventId('notice'), delegation_id: null, content: clip(commentary) });
    }, { silenceMs: deps.silenceMs, startDelayMs: deps.startDelayMs ?? 2000 });
    for (const n of deps.initialNotices?.() ?? []) gate.push(n);
    const timer = setInterval(() => gate.tick(), deps.noticeTickMs ?? 250);
    timer.unref?.();
    const finish = () => {
      if (!sessions.has(id)) return;
      clearInterval(timer);
      sessions.delete(id);
      backend.close?.(id);
      markClosed();
    };
    const sideband = attachSideband(config, id, {
      onEvent: (ev) => onEvent(id, ev),
      onClose: (reason) => {
        if (reason) log.warn(`${id}: sideband closed: ${reason}`);
        finish();
      },
    }, deps.connect ?? nodeWebSocket);
    sessions.set(id, { id, transcript, sideband, gate, closed, markClosed: finish });
  }

  function onEvent(id: string, ev: LiveEvent): void {
    const s = sessions.get(id);
    if (!s) return;
    switch (ev.type) {
      case 'session.input_transcript.delta':
        s.transcript.add('user', ev as never);
        s.gate.speech();
        break;
      case 'session.output_transcript.delta':
        s.transcript.add('assistant', ev as never);
        s.gate.speech();
        break;
      case 'session.delegation.created': {
        const delegation = ev.delegation as { id?: string; target?: string } | undefined;
        if (!delegation?.id || delegation.target !== 'client') break;
        void handleDelegation(s, delegation.id, Number(ev.offset_ms) || 0);
        break;
      }
      case 'session.closed':
        log.info(`${id}: closed`, ev.usage ? JSON.stringify(ev.usage) : '');
        s.sideband.close();
        s.markClosed();
        break;
      case 'error':
        log.warn(`${id}: error event`, JSON.stringify(ev.error ?? ev));
        break;
      default:
        break;
    }
  }

  async function handleDelegation(s: VoiceSessionState & { gate: NoticeGate }, delegationId: string, offsetMs: number): Promise<void> {
    s.gate.delegation(1);
    try {
      await runDelegation(s, delegationId, offsetMs);
    } finally {
      s.gate.delegation(-1);
    }
  }

  async function runDelegation(s: VoiceSessionState, delegationId: string, offsetMs: number): Promise<void> {
    if (settleMs > 0) await new Promise((r) => setTimeout(r, settleMs));
    let content: string;
    try {
      content = await backend.delegate({ sessionId: s.id, delegationId, offsetMs, transcript: s.transcript });
    } catch (err) {
      log.error(`${s.id}: delegation ${delegationId} failed: ${errorMessage(err)}`);
      content = `That didn't work: ${errorMessage(err)}`;
    }
    log.info(`${s.id}: delegation ${delegationId} → ${JSON.stringify(content)}`);
    s.sideband.send({ type: 'session.commentary.append', event_id: eventId('result'), delegation_id: delegationId, content: clip(content) });
  }

  return {
    async open(offerSdp) {
      const live = await createLiveSession(config, offerSdp, deps.fetch);
      // Attach right away so the transcript is complete from the first word.
      attach(live.sessionId);
      backend.open?.(live.sessionId, sessions.get(live.sessionId)!.transcript);
      log.info(`${live.sessionId}: opened`);
      return live;
    },
    get: (id) => sessions.get(id),
    notify(notice) {
      for (const s of sessions.values()) s.gate.push(notice);
    },
    runChanged(run) {
      for (const s of sessions.values()) s.gate.update(run);
    },
    async closeAll() {
      const open = [...sessions.values()];
      for (const s of open) s.sideband.send({ type: 'session.close', event_id: eventId('close') });
      const timeout = new Promise<void>((r) => setTimeout(r, closeTimeoutMs).unref?.());
      await Promise.race([Promise.all(open.map((s) => s.closed)), timeout]);
      for (const s of open) { s.sideband.close(); s.markClosed(); }
    },
  };
}
