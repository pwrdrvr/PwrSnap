/* eslint-disable */
// PwrSnap Sizzle Reels — project editor
// Three timeline variants (Vertical / Horizontal / Storyboard),
// voice drawer at the bottom, export sheet modal.
//
// Exposes window.SZL.SizzleEditor

const SZE_R = React;
const { useState: useStateSZE, useEffect: useEffectSZE, useRef: useRefSZE, useMemo: useMemoSZE } = SZE_R;

const { TRANSITIONS, VOICES, ASSET_BANK,
        transitionByKey, formatDur, totalDur,
        ProjectIcon, KindIcon, TransitionIcon, MiniThumb,
        TransitionsPopover } = window.SZL;

// ============================================================
// VARIANT A — Vertical script-first timeline
// ============================================================
function VerticalTimeline({ project, selectedIdx, setSelectedIdx, onPickTransition, playheadIdx }) {
  const rows = [];
  project.clips.forEach((c, i) => {
    const a = ASSET_BANK.find((x) => x.id === c.assetId);
    if (!a) return;
    const dur = c.durOverride ?? a.dur;
    const words = (c.scriptOverride || "").split(/\s+/).filter(Boolean).length;
    const wpm = Math.round(words / (dur / 60));
    const isActive = i === selectedIdx;
    const isPlaying = i === playheadIdx;
    rows.push(
      <div
        key={"row-"+i}
        className={"szl-vt__row" + (isActive ? " is-active" : "") + (isPlaying ? " is-playing" : "")}
        onClick={() => setSelectedIdx(i)}
      >
        <div className="szl-vt__row-num">
          {String(i+1).padStart(2,"0")}
          <small>{a.kind === "video" ? "VID" : "IMG"}</small>
        </div>
        <div className="szl-vt__row-thumb">
          <MiniThumb assetId={a.id} withPlay={a.kind === "video"} />
          <span className="szl-vt__row-thumb-kind">
            <KindIcon kind={a.kind} size={9}/>{a.kind === "video" ? "VID" : "IMG"}
          </span>
          <span className="szl-vt__row-thumb-dur">{dur.toFixed(1)}s</span>
        </div>
        <div className="szl-vt__row-script">
          <div className="szl-vt__row-script-hdr">
            <div className="szl-vt__row-script-hdr-l">
              <span>{a.stem}</span>
              <span className="ai">
                <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor"><path d="m12 2 2.2 5.4 5.8.4-4.4 3.8 1.4 5.6L12 14.6 6.9 17.2l1.4-5.6L4 7.8l5.8-.4L12 2Z"/></svg>
                rewritten · AI
              </span>
            </div>
            <span className="szl-vt__row-script-hdr-words">{words}w · {wpm} wpm</span>
          </div>
          <textarea defaultValue={c.scriptOverride} rows={2}/>
          <div className="szl-vt__row-script-meta">
            <span>captured: <b>"{a.ocr.slice(0, 40)}…"</b></span>
          </div>
        </div>
        <div className="szl-vt__row-actions">
          <button className="szl-vt__row-action" title="Lock duration">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="5" y="11" width="14" height="9" rx="1"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>
          </button>
          <button className="szl-vt__row-action" title="Generate alt script">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="m12 2 2.2 5.4 5.8.4-4.4 3.8 1.4 5.6L12 14.6 6.9 17.2l1.4-5.6L4 7.8l5.8-.4L12 2Z"/></svg>
          </button>
          <button className="szl-vt__row-action is-danger" title="Remove clip">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="m6 6 12 12M18 6 6 18"/></svg>
          </button>
        </div>
      </div>
    );

    // transition gap
    if (i < project.clips.length - 1) {
      const t = transitionByKey(c.transition);
      rows.push(
        <div key={"trans-"+i} className="szl-vt__trans">
          <button
            className="szl-vt__trans-chip"
            onClick={(e) => { e.stopPropagation(); onPickTransition(i, e.currentTarget); }}
          >
            <TransitionIcon keyName={t.key} size={10}/>
            {t.name}
            <span className="szl-vt__trans-chip-dur">{t.dur === 0 ? "—" : `${t.dur}s`}</span>
          </button>
        </div>
      );
    }
  });

  return <div className="szl-vt">{rows}</div>;
}

// ============================================================
// VARIANT B — Horizontal timeline (classic NLE)
// ============================================================
function HorizontalTimeline({ project, selectedIdx, setSelectedIdx, onPickTransition, playheadSecs, setPlayheadSecs }) {
  // Compute clip x-positions in seconds, sum durations.
  const total = totalDur(project) || 1;
  // mapping: pixels per second
  const widthPct = (secs) => `${(secs / total) * 100}%`;
  // accumulate x positions for transition markers
  let acc = 0;
  const positions = project.clips.map((c, i) => {
    const a = ASSET_BANK.find((x) => x.id === c.assetId);
    const dur = (c.durOverride ?? (a ? a.dur : 0));
    const start = acc;
    acc += dur;
    if (c.transition && i < project.clips.length - 1) acc += transitionByKey(c.transition).dur;
    return { i, a, dur, start, end: start + dur };
  });

  const currentClip = positions.find((p) => playheadSecs >= p.start && playheadSecs <= p.end) || positions[selectedIdx];

  return (
    <div className="szl-ht">
      <div className="szl-ht__preview">
        <div className="szl-ht__monitor">
          <div className="szl-ht__monitor-frame">
            {currentClip && currentClip.a && (
              <MiniThumb assetId={currentClip.a.id} withPlay={currentClip.a.kind === "video"} />
            )}
            {currentClip && currentClip.a && (
              <>
                <div className="szl-ht__monitor-cap">
                  <span className="szl-ht__monitor-cap-num">{String(currentClip.i + 1).padStart(2,"0")}</span>
                  {currentClip.a.stem}
                </div>
                <div className="szl-ht__monitor-time">
                  <b>{formatDur(playheadSecs)}</b>
                  <span style={{ opacity: 0.5 }}>/ {formatDur(total)}</span>
                </div>
              </>
            )}
          </div>
        </div>
        <div className="szl-ht__sidepanel">
          <div className="szl-ht__panel-card">
            <h4>Script · clip <b>{String((currentClip?.i ?? 0)+1).padStart(2,"0")}</b></h4>
            <div style={{ font:"500 12px/1.5 var(--font-sans)", color:"var(--text-primary)" }}>
              "{currentClip ? project.clips[currentClip.i].scriptOverride : ""}"
            </div>
            <div style={{ font:"500 10px/1 var(--font-mono)", color:"var(--text-muted)", marginTop:4 }}>
              {currentClip ? `${currentClip.dur.toFixed(1)}s · captured "${currentClip.a.ocr.slice(0, 30)}…"` : ""}
            </div>
          </div>
          <div className="szl-ht__panel-card">
            <h4>Project · <b>{project.clips.length}</b> clips · <b>{formatDur(total)}</b></h4>
            <div style={{ display:"flex", flexWrap:"wrap", gap:4 }}>
              <span style={{ font:"600 10px/1 var(--font-mono)", padding:"3px 7px", borderRadius:999, background:"var(--bg-input)", border:"1px solid var(--border-subtle)", color:"var(--text-secondary)" }}>16:9</span>
              <span style={{ font:"600 10px/1 var(--font-mono)", padding:"3px 7px", borderRadius:999, background:"var(--bg-input)", border:"1px solid var(--border-subtle)", color:"var(--text-secondary)" }}>1080p</span>
              <span style={{ font:"600 10px/1 var(--font-mono)", padding:"3px 7px", borderRadius:999, background:"var(--accent-soft)", border:"1px solid var(--accent-border)", color:"var(--accent-bright)" }}>voice: {project.voice}</span>
            </div>
            <div style={{ font:"500 10px/1.45 var(--font-mono)", color:"var(--text-muted)", marginTop:4 }}>
              {project.notes}
            </div>
          </div>
        </div>
      </div>

      <div className="szl-ht__tl">
        <div className="szl-ht__ruler">
          {Array.from({ length: Math.floor(total) + 1 }).map((_, sec) => (
            <React.Fragment key={sec}>
              <div className="szl-ht__ruler-tick" style={{ left: `${(sec/total)*100}%` }}/>
              {sec % 5 === 0 && <div className="szl-ht__ruler-label" style={{ left: `${(sec/total)*100}%` }}>{sec}s</div>}
            </React.Fragment>
          ))}
        </div>

        <div className="szl-ht__track" style={{ position:"relative" }}>
          <div className="szl-ht__track-label">Clips</div>
          {positions.map((p, i) => (
            <div
              key={i}
              className={"szl-ht__clip" + (selectedIdx === p.i ? " is-active" : "")}
              style={{ width: widthPct(p.dur), position:"absolute", left: `${(p.start/total)*100}%`, top: 0, bottom: 0 }}
              onClick={() => setSelectedIdx(p.i)}
            >
              <div className="szl-ht__clip-thumb"><MiniThumb assetId={p.a.id}/></div>
              <div className="szl-ht__clip-label">
                <span className="szl-ht__clip-num">{String(p.i+1).padStart(2,"0")}</span>
                {p.a.stem}
              </div>
            </div>
          ))}
          {/* transition markers */}
          {project.clips.slice(0, -1).map((c, i) => {
            const p = positions[i];
            const tr = transitionByKey(c.transition);
            const xPct = ((p.end + tr.dur/2) / total) * 100;
            return (
              <div key={"tm-"+i} className="szl-ht__trans-marker" style={{ left: `${xPct}%` }}>
                <button className="szl-ht__trans-marker-inner" onClick={(e) => onPickTransition(i, e.currentTarget)} title={`${tr.name} · ${tr.dur}s`}>
                  <TransitionIcon keyName={tr.key} size={10}/>
                </button>
              </div>
            );
          })}
          {/* playhead */}
          <div className="szl-ht__playhead" style={{ left: `${(playheadSecs/total)*100}%` }}/>
        </div>

        <div className="szl-ht__track szl-ht__track--script" style={{ position:"relative" }}>
          <div className="szl-ht__track-label">Script</div>
          {positions.map((p, i) => (
            <div
              key={i}
              className="szl-ht__script-seg"
              style={{ width: widthPct(p.dur), position:"absolute", left: `${(p.start/total)*100}%`, top:0, bottom:0 }}
            >
              {project.clips[p.i].scriptOverride}
            </div>
          ))}
        </div>

        <div className="szl-ht__track szl-ht__track--voice" style={{ position:"relative" }}>
          <div className="szl-ht__track-label">Voice · {project.voice}</div>
          <div className="szl-ht__voice-block">
            {Array.from({ length: 80 }).map((_, i) => {
              // pseudo waveform — sine plus randomness
              const h = 12 + Math.abs(Math.sin(i * 0.5)) * 16 + ((i*7)%9);
              return <div key={i} className="szl-ht__voice-bar" style={{ height: h }}/>;
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// VARIANT C — Storyboard grid
// ============================================================
function StoryboardGrid({ project, selectedIdx, setSelectedIdx, onPickTransition }) {
  return (
    <div className="szl-sb">
      {project.clips.map((c, i) => {
        const a = ASSET_BANK.find((x) => x.id === c.assetId);
        if (!a) return null;
        const dur = c.durOverride ?? a.dur;
        const tr = transitionByKey(c.transition);
        const hasTrans = i < project.clips.length - 1;
        return (
          <div
            key={i}
            className={"szl-sb__card" + (selectedIdx === i ? " is-active" : "")}
            onClick={() => setSelectedIdx(i)}
          >
            <div className="szl-sb__card-thumb">
              <MiniThumb assetId={a.id} withPlay={a.kind === "video"}/>
              <span className="szl-sb__card-num">{String(i+1).padStart(2,"0")}</span>
              <span className="szl-sb__card-kind"><KindIcon kind={a.kind} size={8}/>{a.kind === "video" ? "VID" : "IMG"}</span>
              <span className="szl-sb__card-dur">{dur.toFixed(1)}s</span>
            </div>
            <div className="szl-sb__card-body">
              <span className="szl-sb__card-stem">{a.stem}</span>
              <span className="szl-sb__card-script">{c.scriptOverride}</span>
              <div className="szl-sb__card-foot">
                <span>cap "{a.ocr.slice(0, 22)}…"</span>
                {hasTrans && (
                  <button className="szl-sb__card-foot-chip" onClick={(e) => { e.stopPropagation(); onPickTransition(i, e.currentTarget); }}>
                    <TransitionIcon keyName={tr.key} size={10}/>
                    {tr.name}
                  </button>
                )}
              </div>
            </div>
            {hasTrans && (
              <button
                className="szl-sb__trans-arrow"
                onClick={(e) => { e.stopPropagation(); onPickTransition(i, e.currentTarget); }}
                title={`${tr.name} · ${tr.dur}s`}
              >
                <TransitionIcon keyName={tr.key} size={9}/>
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ============================================================
// VOICE DRAWER — bottom of editor
// ============================================================
function VoiceDrawer({ project, expanded, setExpanded, currentVoice, setCurrentVoice, isRecording }) {
  const v = VOICES.find((x) => x.key === currentVoice) || VOICES[0];
  const total = totalDur(project);
  return (
    <div className="szl-voice">
      <div className="szl-voice__hdr" onClick={() => setExpanded(!expanded)}>
        <div className="szl-voice__hdr-l">
          <span className="szl-voice__hdr-l-icon">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2a4 4 0 0 0-4 4v6a4 4 0 1 0 8 0V6a4 4 0 0 0-4-4z"/><path d="M5 11v1a7 7 0 0 0 14 0v-1M12 19v3"/></svg>
          </span>
          Voiceover
          <span style={{ font:"500 10px/1 var(--font-mono)", color:"var(--accent-bright)", padding:"2px 6px", background:"var(--accent-soft)", border:"1px solid var(--accent-border)", borderRadius: 999 }}>
            {v.name.toLowerCase()}
          </span>
        </div>
        <div className="szl-voice__hdr-meta">
          <span>VO: <b>{formatDur(total + 0.4)}</b></span>
          <span>·</span>
          <span>cut-to-fit · on</span>
          <span>·</span>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ transform: expanded ? "rotate(180deg)" : "rotate(0)" }}><path d="m6 9 6 6 6-6"/></svg>
        </div>
      </div>

      {expanded && (
        <div className="szl-voice__body">
          <div className="szl-voice__col">
            <h5>Voice <b>· {VOICES.length} options</b></h5>
            {VOICES.map((vc) => (
              <div
                key={vc.key}
                className={"szl-voice__voice-card" + (vc.key === currentVoice ? " is-active" : "")}
                onClick={() => setCurrentVoice(vc.key)}
              >
                <div className="szl-voice__voice-card-row">
                  <span className="szl-voice__voice-card-name">{vc.name}</span>
                  <span className="szl-voice__voice-card-tag">{vc.tag}</span>
                </div>
                <span className="szl-voice__voice-card-desc">{vc.desc}</span>
                <div className="szl-voice__voice-card-wave">
                  {(vc.pitches.length ? vc.pitches : [3,4,2,3,2,3,4,2,3,4]).map((p, i) => (
                    <div key={i} className="szl-voice__voice-card-wave-bar" style={{ height: p * 1.1 }}/>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="szl-voice__col">
            <h5>Waveform <b>· {formatDur(total + 0.4)} · {Math.round((total + 0.4) / total * 100) + "%"} fit</b></h5>
            <div className="szl-voice__wave">
              <div className="szl-voice__wave-meta">
                <span>00:00.0</span>
                <span><b>VO {formatDur(total + 0.4)}</b></span>
                <span>{formatDur(total)}</span>
              </div>
              {Array.from({ length: 110 }).map((_, i) => {
                const h = 14 + Math.abs(Math.sin(i * 0.4 + 0.6)) * 36 + ((i*11)%14);
                const played = i < 38;
                return <div key={i} className={"szl-voice__wave-bar" + (played ? " played" : "")} style={{ height: h }}/>;
              })}
            </div>
            <div className="szl-voice__resync">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-3-6.7M21 4v5h-5"/></svg>
              <span>
                <b>Auto-cut applied.</b> Clip 03 extended <b>+0.3s</b>, clip 05 trimmed <b>-0.2s</b> so visuals match the {v.name} read at 110 wpm.
              </span>
            </div>
          </div>

          <div className="szl-voice__col">
            <h5>Action</h5>
            <button className="szl-voice__btn szl-voice__btn--primary">
              <span className="szl-voice__btn-icon">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M5 4v16l14-8z"/></svg>
              </span>
              <span className="szl-voice__btn-l">
                <b>Preview reel</b>
                <small>play with VO · ⌘P</small>
              </span>
            </button>
            <button className="szl-voice__btn">
              <span className="szl-voice__btn-icon">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="6"/></svg>
              </span>
              <span className="szl-voice__btn-l">
                <b>{isRecording ? "Recording…" : "Record yourself"}</b>
                <small>mic input · ⌘R</small>
              </span>
            </button>
            <button className="szl-voice__btn">
              <span className="szl-voice__btn-icon">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 4v12M6 10l6-6 6 6M4 20h16"/></svg>
              </span>
              <span className="szl-voice__btn-l">
                <b>Upload audio</b>
                <small>WAV / MP3 · drag-drop</small>
              </span>
            </button>
            <button className="szl-voice__btn">
              <span className="szl-voice__btn-icon">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="m12 2 2.2 5.4 5.8.4-4.4 3.8 1.4 5.6L12 14.6 6.9 17.2l1.4-5.6L4 7.8l5.8-.4L12 2Z"/></svg>
              </span>
              <span className="szl-voice__btn-l">
                <b>Regenerate VO</b>
                <small>re-read with {v.name}</small>
              </span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// EXPORT SHEET
// ============================================================
const EXPORT_TARGETS = [
  { key: "mp4",     name: "MP4",         meta: "1080p · 16:9 · ~14MB",
    icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="6" width="14" height="12" rx="1.5"/><path d="m17 10 4-2v8l-4-2z" fill="currentColor"/></svg> },
  { key: "youtube", name: "YouTube",     meta: "auto-publish · 16:9",
    icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M22 8a4 4 0 0 0-3-3 100 100 0 0 0-7-.4 100 100 0 0 0-7 .4 4 4 0 0 0-3 3v8a4 4 0 0 0 3 3 100 100 0 0 0 7 .4 100 100 0 0 0 7-.4 4 4 0 0 0 3-3z" opacity="0.18"/><polygon points="10,8 16,12 10,16" fill="currentColor"/></svg> },
  { key: "twitter", name: "X / Twitter", meta: "≤2:20 · auto-trim",
    icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M18 3h3l-7 9 8 9h-6l-5-6-5 6H3l8-10L3 3h6l4 5z"/></svg> },
];

function ExportSheet({ project, onClose }) {
  const [targets, setTargets] = useStateSZE(new Set(["mp4"]));
  const toggle = (k) => {
    const s = new Set(targets);
    if (s.has(k)) s.delete(k); else s.add(k);
    setTargets(s);
  };
  const total = totalDur(project);
  return (
    <div className="szl-export-backdrop" onClick={onClose}>
      <div className="szl-export" onClick={(e) => e.stopPropagation()}>
        <div className="szl-export__hdr">
          <h3>Export <span className="a">{project.name}</span></h3>
          <button className="szl-export__close" onClick={onClose}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="m6 6 12 12M18 6 6 18"/></svg>
          </button>
        </div>
        <div className="szl-export__body">
          <div className="szl-export__targets">
            {EXPORT_TARGETS.map((t) => (
              <button
                key={t.key}
                className={"szl-export__target" + (targets.has(t.key) ? " is-on" : "")}
                onClick={() => toggle(t.key)}
              >
                <span className="szl-export__target-pick">
                  {targets.has(t.key) && <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 5 5 9-11"/></svg>}
                </span>
                <span className="szl-export__target-icon">{t.icon}</span>
                <span className="szl-export__target-name">{t.name}</span>
                <span className="szl-export__target-meta">{t.meta}</span>
              </button>
            ))}
          </div>

          <div className="szl-export__opts">
            <div className="szl-export__opt">
              <label>Resolution</label>
              <select defaultValue="1080">
                <option value="720">720p</option>
                <option value="1080">1080p</option>
                <option value="1440">1440p</option>
                <option value="2160">4K</option>
              </select>
            </div>
            <div className="szl-export__opt">
              <label>Aspect</label>
              <select defaultValue="16:9">
                <option>16:9 (landscape)</option>
                <option>9:16 (vertical)</option>
                <option>1:1 (square)</option>
              </select>
            </div>
            <div className="szl-export__opt">
              <label>Bitrate</label>
              <select defaultValue="auto">
                <option>auto</option>
                <option>8 Mbps</option>
                <option>16 Mbps</option>
                <option>32 Mbps</option>
              </select>
            </div>
            <div className="szl-export__opt">
              <label>Captions</label>
              <select defaultValue="burn">
                <option value="off">off</option>
                <option value="burn">burned-in</option>
                <option value="sidecar">.srt sidecar</option>
              </select>
            </div>
          </div>

          <div className="szl-export__summary">
            <span>Duration: <b>{formatDur(total + 0.4)}</b></span>
            <span>Clips: <b>{project.clips.length}</b></span>
            <span>Voice: <b>{project.voice}</b></span>
            <span>Audio: <b>VO + ambient</b></span>
            <span>Est. encode: <b>~22s</b></span>
            <span>Est. size (MP4): <b>~14 MB</b></span>
          </div>
        </div>
        <div className="szl-export__foot">
          <div className="szl-export__foot-hint">
            <b style={{ color:"var(--accent-bright)" }}>{targets.size}</b> destination{targets.size === 1 ? "" : "s"} · ready to render
          </div>
          <div className="szl-export__foot-r">
            <button onClick={onClose}>Cancel</button>
            <button className="is-primary">Render & ship</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// MAIN EDITOR shell
// ============================================================
function SizzleEditor({
  project, onBack, onOpenExport,
  variant = "vertical", setVariant,
  selectedIdx, setSelectedIdx,
  voiceExpanded, setVoiceExpanded,
}) {
  const [playheadSecs, setPlayheadSecs] = useStateSZE(8.5);
  const [transPop, setTransPop] = useStateSZE(null); // { i, x, y } when open
  const [exportOpen, setExportOpen] = useStateSZE(false);

  const onPickTransition = (clipIdx, anchorEl) => {
    if (!anchorEl) { setTransPop(null); return; }
    const rect = anchorEl.getBoundingClientRect();
    const bodyEl = anchorEl.closest(".szl-ed");
    const bRect = bodyEl ? bodyEl.getBoundingClientRect() : { left: 0, top: 0 };
    setTransPop({ i: clipIdx, x: rect.left - bRect.left, y: rect.top - bRect.top + rect.height + 6 });
  };

  const total = totalDur(project);

  // Approx playhead → clip idx
  let acc = 0;
  let playheadIdx = 0;
  for (let i = 0; i < project.clips.length; i++) {
    const a = ASSET_BANK.find((x) => x.id === project.clips[i].assetId);
    const dur = project.clips[i].durOverride ?? (a ? a.dur : 0);
    if (playheadSecs >= acc && playheadSecs <= acc + dur) { playheadIdx = i; break; }
    acc += dur + (project.clips[i].transition && i < project.clips.length - 1 ? transitionByKey(project.clips[i].transition).dur : 0);
  }

  return (
    <div className="szl-ed" onClick={() => setTransPop(null)}>
      <div className="szl-ed__hdr">
        <div className="szl-ed__hdr-l">
          <button className="szl-ed__hdr-back" onClick={onBack} title="Back to library">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="m15 6-6 6 6 6"/></svg>
          </button>
          <span className="szl-ed__hdr-mark"><ProjectIcon size={12}/></span>
          <div className="szl-ed__hdr-title">
            <div className="szl-ed__hdr-title-row">
              <span className="szl-ed__hdr-kind">Sizzle reel</span>
            </div>
            <input className="szl-ed__hdr-name" defaultValue={project.name}/>
          </div>
          <div className="szl-ed__hdr-meta">
            <span><b>{project.clips.length}</b> clips</span>
            <span><b>{formatDur(total)}</b></span>
            <span>voice: <b>{project.voice}</b></span>
            <span>1080p · 16:9</span>
          </div>
        </div>
        <div className="szl-ed__hdr-c">
          <div className="szl-ed__variants">
            <button className={"szl-ed__variant" + (variant === "vertical" ? " is-active" : "")} onClick={() => setVariant("vertical")}>
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="4" y="4" width="6" height="6"/><rect x="4" y="14" width="6" height="6"/><path d="M14 7h6M14 17h6"/></svg>
              Script
            </button>
            <button className={"szl-ed__variant" + (variant === "horizontal" ? " is-active" : "")} onClick={() => setVariant("horizontal")}>
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="7" width="6" height="10"/><rect x="11" y="7" width="6" height="10"/><rect x="19" y="7" width="2" height="10"/></svg>
              Timeline
            </button>
            <button className={"szl-ed__variant" + (variant === "storyboard" ? " is-active" : "")} onClick={() => setVariant("storyboard")}>
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="8" height="8"/><rect x="13" y="3" width="8" height="8"/><rect x="3" y="13" width="8" height="8"/><rect x="13" y="13" width="8" height="8"/></svg>
              Storyboard
            </button>
          </div>
        </div>
        <div className="szl-ed__hdr-r">
          <button className="szl-ed__hdr-btn" title="Open in new window">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7"/></svg>
            Pop out
          </button>
          <button className="szl-ed__hdr-btn is-primary" onClick={() => setExportOpen(true)}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 16V4M6 10l6-6 6 6M4 20h16"/></svg>
            Export
          </button>
        </div>
      </div>

      <div className="szl-ed__body">
        {variant === "vertical" && (
          <VerticalTimeline
            project={project}
            selectedIdx={selectedIdx}
            setSelectedIdx={setSelectedIdx}
            onPickTransition={onPickTransition}
            playheadIdx={playheadIdx}
          />
        )}
        {variant === "horizontal" && (
          <HorizontalTimeline
            project={project}
            selectedIdx={selectedIdx}
            setSelectedIdx={setSelectedIdx}
            onPickTransition={onPickTransition}
            playheadSecs={playheadSecs}
            setPlayheadSecs={setPlayheadSecs}
          />
        )}
        {variant === "storyboard" && (
          <StoryboardGrid
            project={project}
            selectedIdx={selectedIdx}
            setSelectedIdx={setSelectedIdx}
            onPickTransition={onPickTransition}
          />
        )}
        {transPop && (
          <TransitionsPopover
            current={project.clips[transPop.i].transition}
            onPick={(k) => { project.clips[transPop.i].transition = k; setTransPop(null); }}
            style={{ left: transPop.x, top: transPop.y }}
          />
        )}
        <VoiceDrawer
          project={project}
          expanded={voiceExpanded}
          setExpanded={setVoiceExpanded}
          currentVoice={project.voice}
          setCurrentVoice={(v) => { project.voice = v; setSelectedIdx(selectedIdx); }}
          isRecording={false}
        />
      </div>

      <div className="szl-ed__transport">
        <button className="szl-ed__transport-btn" title="Prev clip">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M19 5v14l-12-7zM5 5h2v14H5z"/></svg>
        </button>
        <button className="szl-ed__transport-btn is-play" title="Play">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"/></svg>
        </button>
        <button className="szl-ed__transport-btn" title="Next clip">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M5 5v14l12-7zM17 5h2v14h-2z"/></svg>
        </button>
        <div className="szl-ed__transport-time">
          <span>{formatDur(playheadSecs)}</span>
          <span className="sep"> / </span>
          <span className="total">{formatDur(total)}</span>
        </div>
        <div className="szl-ed__transport-bar" onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const f = (e.clientX - r.left) / r.width;
          setPlayheadSecs(Math.max(0, Math.min(total, f * total)));
        }}>
          <div className="szl-ed__transport-bar-fill" style={{ width: `${(playheadSecs/total)*100}%` }}/>
          <div className="szl-ed__transport-bar-thumb" style={{ left: `${(playheadSecs/total)*100}%` }}/>
        </div>
        <div className="szl-ed__transport-meta">
          <span>clip <b>{String(playheadIdx+1).padStart(2,"0")}</b> · {ASSET_BANK.find(a => a.id === project.clips[playheadIdx].assetId)?.kind || "—"}</span>
          <span>VO: <b>110 wpm</b> · {project.voice}</span>
        </div>
      </div>

      {exportOpen && <ExportSheet project={project} onClose={() => setExportOpen(false)}/>}
    </div>
  );
}

window.SZL = window.SZL || {};
Object.assign(window.SZL, { SizzleEditor, VerticalTimeline, HorizontalTimeline, StoryboardGrid, VoiceDrawer, ExportSheet });
