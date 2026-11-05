/** Table talk on screen: the reactions and voice dock, reactions floating off the player bars, and who is on voice. */
import { useEffect, useRef, useState } from 'react';
import { REACTIONS, type Colour } from '@cr/chess-core';
import { useOnline } from './online';
import { joinVoice, leaveVoice, react, retryVoice, toggleMute, toggleSilence, useTalk, voiceSupported, type VoiceState } from './talk';

const STATUS: Record<VoiceState, string> = {
  off: '',
  asking: 'Allow the microphone to start…',
  waiting: 'You’re on. Waiting for your opponent to switch voice on.',
  connecting: 'Connecting…',
  live: 'Connected',
  failed: 'Couldn’t connect on this network.',
};

/** The two buttons by the bottom bar, for the players of an online game. */
export function TalkDock() {
  const g = useOnline((s) => s.game);
  const t = useTalk();
  const [open, setOpen] = useState<'react' | 'voice' | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(null);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(null);
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  if (!g?.you || (g.status !== 'playing' && g.status !== 'over')) return null;
  const them = (g.you === 'w' ? g.black?.name : g.white?.name) ?? 'Your opponent';
  const on = t.voice !== 'off';
  const peerOn = t.code === g.code && t.peer.on;
  const micLabel = !on ? (peerOn ? `Voice chat: ${them} is on voice` : 'Voice chat') : t.muted ? 'Voice chat: you are muted' : 'Voice chat: you are on';

  return (
    <div className="k-talk" ref={ref}>
      {open === 'react' && (
        <div className="k-talk-pop panel" role="dialog" aria-label="Send a reaction">
          <div className="k-react-grid">
            {REACTIONS.map((e) => (
              <button key={e} className="k-react-btn" aria-label={`Send ${e}`} onClick={() => react(e)}>
                {e}
              </button>
            ))}
          </div>
        </div>
      )}
      {open === 'voice' && (
        <div className="k-talk-pop panel" role="dialog" aria-label="Voice chat">
          <h3>Voice chat</h3>
          {!on ? (
            <>
              <p>
                Talk with <b>{them}</b> while you play. They hear you only once they switch voice on too, and spectators never do.
              </p>
              <p className="k-talk-peer">{peerOn ? `🎙 ${them} is on voice${t.peer.muted ? ' (muted)' : ''}.` : `${them} hasn’t switched voice on.`}</p>
              {voiceSupported() ? (
                <button className="btn btn-primary" onClick={() => void joinVoice()}>
                  🎙 Switch voice on
                </button>
              ) : (
                <p className="k-talk-peer">This browser can’t do voice chat. Try Chrome, Safari or Firefox.</p>
              )}
            </>
          ) : (
            <>
              <p className={`k-talk-status s-${t.voice}`} role="status">
                {t.voice === 'live' ? `Connected with ${them}` : STATUS[t.voice]}
                {t.voice === 'live' && t.peer.muted ? ` · ${them} is muted` : ''}
              </p>
              <div className="k-talk-actions">
                <button className="btn" onClick={toggleMute} aria-pressed={t.muted} disabled={t.voice === 'asking'}>
                  {t.muted ? '🎙 Unmute me' : '🔇 Mute me'}
                </button>
                <button className="btn" onClick={toggleSilence} aria-pressed={t.peerSilenced}>
                  {t.peerSilenced ? `🔈 Hear ${them}` : `🔕 Silence ${them}`}
                </button>
                {t.voice === 'failed' && (
                  <button className="btn" onClick={retryVoice}>
                    Try again
                  </button>
                )}
                <button className="btn" onClick={() => leaveVoice()}>
                  Leave voice
                </button>
              </div>
            </>
          )}
        </div>
      )}
      <button
        className={`k-talk-btn${open === 'react' ? ' on' : ''}`}
        aria-label="Reactions"
        aria-expanded={open === 'react'}
        onClick={() => setOpen(open === 'react' ? null : 'react')}
      >
        🙂
      </button>
      <button
        className={`k-talk-btn mic v-${t.voice}${t.muted ? ' muted' : ''}${!on && peerOn ? ' ask' : ''}${open === 'voice' ? ' on' : ''}`}
        aria-label={micLabel}
        aria-expanded={open === 'voice'}
        onClick={() => setOpen(open === 'voice' ? null : 'voice')}
      >
        {on && t.muted ? '🔇' : '🎙'}
      </button>
    </div>
  );
}

/** Reactions rising off a player's bar (or dropping from the top one). */
export function TalkFloats({ colour, where }: { colour: Colour; where: 'top' | 'bottom' }) {
  const floats = useTalk((s) => s.floats);
  const code = useTalk((s) => s.code);
  const g = useOnline((s) => s.game);
  if (!g || code !== g.code) return null;
  const mine = floats.filter((f) => f.by === colour);
  if (!mine.length) return null;
  return (
    <div className={`k-floats ${where}`} aria-live="polite">
      {mine.map((f, i) => (
        <span key={f.id} className="k-float" style={{ left: `${18 + ((f.id * 37) % 60)}%`, animationDelay: `${i * 30}ms` }}>
          {f.emoji}
        </span>
      ))}
    </div>
  );
}

/** A small microphone next to the name of a player who is on voice. */
export function VoiceBadge({ colour }: { colour: Colour }) {
  const g = useOnline((s) => s.game);
  const t = useTalk();
  if (!g?.you || t.code !== g.code) return null;
  const mine = colour === g.you;
  const on = mine ? t.voice !== 'off' && t.voice !== 'asking' : t.peer.on;
  if (!on) return null;
  const muted = mine ? t.muted : t.peer.muted;
  const live = t.voice === 'live';
  return (
    <span className={`k-voice-badge${muted ? ' muted' : ''}${live ? ' live' : ''}`} title={muted ? 'On voice, muted' : 'On voice'} aria-label={muted ? 'on voice, muted' : 'on voice'}>
      {muted ? '🔇' : '🎙'}
    </span>
  );
}
