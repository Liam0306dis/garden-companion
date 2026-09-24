/** The Garden Overview's stylesheet, injected once when the overview first mounts. */

const STYLE_ID = 'gc-overview-style';
export const PANEL_ID = 'gc-overview-panel';
export const BUTTON_ID = 'gc-overview-button';

export function injectOverviewStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  // Local aliases for the companion's design tokens, each with the companion's value as fallback,
  // so the overview keeps its look even if it ever mounts before the main stylesheet.
  style.textContent = `
    #${PANEL_ID},#${BUTTON_ID}{--go-bg:var(--gc-bg,#141417);--go-surface:var(--gc-surface,#1a1a1e);--go-surface-2:var(--gc-surface-2,#222227);--go-surface-3:var(--gc-surface-3,#2a2a30);--go-input:var(--gc-input,#0e0e10);--go-line:var(--gc-line,rgba(255,255,255,.07));--go-line-strong:var(--gc-line-strong,rgba(255,255,255,.12));--go-text:var(--gc-text,#ececef);--go-strong:var(--gc-strong,#fafafa);--go-muted:var(--gc-muted,#a1a1aa);--go-faint:var(--gc-faint,#83838d);--go-accent:var(--gc-accent,#7c6cf2);--go-accent-text:var(--gc-accent-text,#b3a9ff);--go-accent-soft:var(--gc-accent-soft,rgba(124,108,242,.14));--go-accent-line:var(--gc-accent-line,rgba(124,108,242,.45));--go-green:var(--gc-green,#3ecf8e);--go-gold:var(--gc-gold,#f5c04a);--go-font:var(--gc-font,"Segoe UI",system-ui,sans-serif);--go-mono:var(--gc-mono,ui-monospace,Consolas,monospace)}
    #${BUTTON_ID}{position:fixed;left:10px;bottom:10px;z-index:99988;width:32px;height:32px;padding:0;display:grid;place-items:center;border:1px solid var(--go-line-strong);border-radius:9px;background:var(--go-bg);color:var(--go-text);font-size:16px;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.45)}
    /* Solid on hover rather than translucent: this button sits on the game canvas, so a see-through
       fill would show the garden through it instead of lighting it up. */
    #${BUTTON_ID}:hover{background:var(--go-surface-2)}
    #${PANEL_ID}{position:fixed;inset:0;z-index:999994;display:grid;place-items:center;padding:18px;box-sizing:border-box;background:transparent;pointer-events:none;color:var(--go-text);font:13px/1.45 var(--go-font);-webkit-font-smoothing:antialiased}
    #${PANEL_ID} *,#${PANEL_ID} *::before,#${PANEL_ID} *::after{box-sizing:border-box}
    #${PANEL_ID}[hidden]{display:none}
    #${PANEL_ID} .go-stage{display:flex;align-items:flex-start;gap:8px;pointer-events:none}
    #${PANEL_ID} .go-card{width:min(344px,94vw);max-height:90vh;display:flex;flex-direction:column;overflow:hidden;pointer-events:auto;border:1px solid var(--go-line-strong);border-radius:14px;background:var(--go-bg);box-shadow:0 24px 64px rgba(0,0,0,.55),0 2px 8px rgba(0,0,0,.35);z-index:1}
    #${PANEL_ID} .go-config-card{width:300px;max-height:90vh;display:flex;flex-direction:column;overflow:hidden;pointer-events:auto;border:1px solid var(--go-line-strong);border-radius:14px;background:var(--go-bg);box-shadow:0 24px 64px rgba(0,0,0,.55),0 2px 8px rgba(0,0,0,.35);z-index:2}
    #${PANEL_ID} header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 8px 10px 12px;color:var(--go-strong);border-bottom:1px solid var(--go-line);cursor:move;touch-action:none;user-select:none}
    #${PANEL_ID} .go-config-card header{padding-left:16px}
    #${PANEL_ID} h2{flex:0 0 auto;display:flex;align-items:center;gap:6px;margin:0;white-space:nowrap;font:650 14px/1.2 var(--go-font);letter-spacing:-.005em}
    #${PANEL_ID} header .go-actions{display:flex;flex:0 0 auto;align-items:center;gap:2px}
    #${PANEL_ID} button{min-height:28px;padding:5px 10px;border:1px solid var(--go-line-strong);border-radius:7px;background:var(--go-surface-2);color:var(--go-text);cursor:pointer;font:500 12px/1.2 var(--go-font);white-space:nowrap;transition:background .12s,border-color .12s,color .12s}
    #${PANEL_ID} button:hover{color:var(--go-strong);border-color:rgba(255,255,255,.18);background:var(--go-surface-3)}
    #${PANEL_ID} button:focus-visible{outline:2px solid var(--go-accent-line);outline-offset:1px}
    #${PANEL_ID} button:disabled{opacity:.45;cursor:default}
    /* Icon buttons: header actions and section tools. Borderless until hovered or switched on. */
    #${PANEL_ID} header button,#${PANEL_ID} .go-section-actions button{width:30px;min-width:30px;height:30px;min-height:0;display:grid;place-items:center;padding:0;border-color:transparent;background:transparent;color:var(--go-muted)}
    #${PANEL_ID} header button svg,#${PANEL_ID} .go-section-actions button svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
    #${PANEL_ID} header button:hover,#${PANEL_ID} .go-section-actions button:hover{color:var(--go-text);border-color:transparent;background:var(--go-surface-2)}
    #${PANEL_ID} header button[data-active=true],#${PANEL_ID} .go-section-actions button[data-active=true]{color:var(--go-accent-text);border-color:transparent;background:var(--go-accent-soft)}
    #${PANEL_ID} .go-body{min-height:0;overflow:auto;padding:0;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.12) transparent}
    #${PANEL_ID} .go-config-body{min-height:0;overflow:auto;padding:0 14px 14px;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.12) transparent}
    #${PANEL_ID} .go-config-body .go-section{padding:4px 0 0;border-bottom:0}
    #${PANEL_ID} .go-section{padding:14px 14px;border-bottom:1px solid var(--go-line)}
    #${PANEL_ID} .go-section-title{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;color:var(--go-faint);font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase}
    #${PANEL_ID} .go-section-title>span:first-child{display:flex;align-items:center}
    #${PANEL_ID} .go-section-title>span:last-child:not(:first-child){order:2;margin-left:8px;white-space:nowrap;color:var(--go-muted);font-size:11px;font-weight:500;letter-spacing:0;text-transform:none}
    #${PANEL_ID} .go-section-title>span>small{margin-left:7px;padding:1px 7px;border-radius:999px;background:var(--go-surface-2);color:var(--go-text);font-size:11px;font-weight:600;letter-spacing:0;font-variant-numeric:tabular-nums}
    #${PANEL_ID} .go-collapsible{cursor:pointer;margin:0}
    #${PANEL_ID} .go-collapsible:hover{color:var(--go-text)}
    /* A bordered control rather than a loose glyph, so it reads as something you can press. */
    #${PANEL_ID} .go-chevron{order:2;display:grid;place-items:center;width:24px;height:24px;flex:0 0 24px;margin-left:8px;border:1px solid var(--go-line);border-radius:7px;background:transparent;color:var(--go-muted);text-decoration:none;transition:background .12s,color .12s}
    #${PANEL_ID} .go-chevron svg,#${PANEL_ID} .go-plant-row>span>u svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
    #${PANEL_ID} .go-collapsible:hover .go-chevron{color:var(--go-text);background:var(--go-surface-2)}
    #${PANEL_ID} [data-section]{margin-top:10px}
    #${PANEL_ID} .go-collapsible:hover>span>small{background:var(--go-surface-3)}
    /* Growth */
    #${PANEL_ID} .go-summary{display:grid;grid-template-columns:repeat(2,1fr);gap:6px;margin:0}
    #${PANEL_ID} .go-summary[data-tiles="3"]{grid-template-columns:repeat(3,1fr)}
    #${PANEL_ID} .go-metric{min-width:0;padding:9px 10px;border:1px solid var(--go-line);border-radius:10px;background:var(--go-surface)}
    #${PANEL_ID} .go-metric small{display:block;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:var(--go-muted);font-size:11px;font-weight:500}
    #${PANEL_ID} .go-metric b{display:block;margin-top:2px;white-space:nowrap;color:var(--go-strong);font:650 16px/1.25 var(--go-font);font-variant-numeric:tabular-nums}
    #${PANEL_ID} .go-metric.go-growing b{color:var(--go-gold)}
    #${PANEL_ID} .go-metric.go-size b{color:#fb923c}
    #${PANEL_ID} .go-status{display:flex;align-items:center;gap:8px;padding:9px 11px;border:1px solid var(--go-line);border-radius:10px;background:var(--go-surface);font-size:13px}
    #${PANEL_ID} .go-status::before{content:'';width:7px;height:7px;flex:0 0 auto;border-radius:50%;background:var(--go-gold)}
    #${PANEL_ID} .go-status b{color:var(--go-strong);font-weight:650;font-variant-numeric:tabular-nums}
    #${PANEL_ID} .go-status[data-tone=done]{color:var(--go-green);border-color:rgba(62,207,142,.3);background:rgba(62,207,142,.07);font-weight:600}
    #${PANEL_ID} .go-status[data-tone=done]::before{background:var(--go-green)}
    /* Mutation progress */
    #${PANEL_ID} .go-progress{padding:6px 0}
    #${PANEL_ID} .go-progress:first-child{padding-top:0}
    #${PANEL_ID} .go-progress>div{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;color:var(--go-text);font-size:13px}
    #${PANEL_ID} .go-progress span{display:flex;align-items:center;gap:8px}
    #${PANEL_ID} .go-progress span i{width:8px;height:8px;flex:0 0 auto;border-radius:50%}
    #${PANEL_ID} .go-progress b{font:650 13px var(--go-font);font-variant-numeric:tabular-nums}
    #${PANEL_ID} .go-of{color:var(--go-faint);font-weight:400}
    #${PANEL_ID} .go-progress>i{display:block;height:6px;overflow:hidden;border-radius:999px;background:var(--go-surface-3)}
    #${PANEL_ID} .go-progress>i u{display:block;height:100%;border-radius:999px;text-decoration:none}
    /* Mutation estimates */
    #${PANEL_ID} .go-section-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:-6px 0 8px}
    #${PANEL_ID} .go-section-head .go-section-title{flex:1;margin:0}
    #${PANEL_ID} .go-section-actions{display:flex;align-items:center;gap:2px;margin-right:-6px}
    #${PANEL_ID} .go-eta-detail,#${PANEL_ID} .go-eta-done{padding:9px 11px;border:1px solid var(--go-line);border-radius:10px;background:var(--go-surface);color:var(--go-text)}
    #${PANEL_ID} .go-eta-detail+.go-eta-detail,#${PANEL_ID} .go-eta-detail+.go-eta-done,#${PANEL_ID} .go-eta-done+.go-eta-detail,#${PANEL_ID} .go-eta-done+.go-eta-done{margin-top:6px}
    #${PANEL_ID} .go-eta-detail>div,#${PANEL_ID} .go-eta-done{display:flex;align-items:center;justify-content:space-between;gap:8px}
    #${PANEL_ID} .go-eta-detail span,#${PANEL_ID} .go-eta-done span{display:flex;min-width:0;align-items:center;gap:8px;font-size:13px;font-weight:500}
    #${PANEL_ID} .go-eta-detail span i,#${PANEL_ID} .go-eta-done span i{width:8px;height:8px;flex:0 0 auto;border-radius:50%}
    #${PANEL_ID} .go-eta-detail b{flex:0 0 auto;font:650 13px var(--go-font);font-variant-numeric:tabular-nums}
    #${PANEL_ID} .go-eta-detail em{margin-left:1px;color:var(--go-faint);font-size:12px;font-weight:400;font-style:normal}
    #${PANEL_ID} .go-eta-detail>u{display:block;height:5px;margin-top:8px;overflow:hidden;border-radius:999px;background:var(--go-surface-3);text-decoration:none}
    #${PANEL_ID} .go-eta-detail>u i{display:block;height:100%;border-radius:999px}
    #${PANEL_ID} .go-eta-detail>small{display:block;margin-top:7px;color:var(--go-muted);font-size:11px;font-variant-numeric:tabular-nums}
    #${PANEL_ID} .go-eta-done{border-color:rgba(62,207,142,.3);background:rgba(62,207,142,.07)}
    #${PANEL_ID} .go-eta-done span i{background:var(--go-green)}
    #${PANEL_ID} .go-eta-done b{color:var(--go-green);font:600 12px var(--go-font)}
    /* Plants table */
    #${PANEL_ID} .go-plants{overflow:hidden;border:1px solid var(--go-line);border-radius:10px;background:var(--go-surface)}
    #${PANEL_ID} .go-plants>p{margin:0;padding:10px}
    #${PANEL_ID} .go-plant-row{display:grid;grid-template-columns:minmax(0,1fr) 42px 42px;align-items:center;gap:6px;padding:5px 0;color:var(--go-text);font-size:13px}
    #${PANEL_ID} .go-plant-row+.go-plant-row{border-top:1px solid var(--go-line)}
    #${PANEL_ID} .go-plant-row>span{display:flex;min-width:0;align-items:center;gap:7px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
    #${PANEL_ID} .go-plant-row>b{font-weight:600;text-align:right;font-variant-numeric:tabular-nums}
    #${PANEL_ID} .go-plant-row img,#${PANEL_ID} .go-plant-blank{width:20px;height:20px;flex:0 0 20px;object-fit:contain;image-rendering:auto}
    #${PANEL_ID} .go-plant-row>span>u{display:grid;place-items:center;width:18px;height:18px;flex:0 0 18px;border-radius:5px;color:var(--go-muted);text-decoration:none}
    #${PANEL_ID} .go-plant-family>span>u{color:var(--go-accent-text)}
    #${PANEL_ID} .go-plant-family:hover>span>u{background:var(--go-accent-soft)}
    #${PANEL_ID} .go-plant-row>span>u svg{width:12px;height:12px}
    /* Indenting the name cell rather than the row, so the tiles and crops columns stay aligned. */
    #${PANEL_ID} .go-plant-row[data-child=true]{color:var(--go-muted);background:rgba(0,0,0,.14)}
    #${PANEL_ID} .go-plant-row[data-child=true]>span{padding-left:18px}
    #${PANEL_ID} .go-plant-family{cursor:pointer}
    #${PANEL_ID} .go-plant-family:hover{color:#fff;background:rgba(255,255,255,.03)}
    /* Only on rows that are not children: a child inherits the muted row colour instead. */
    #${PANEL_ID} .go-plant-row:not([data-child=true])>span{color:var(--go-strong)}
    #${PANEL_ID} .go-plant-family:hover>span{color:#fff}
    #${PANEL_ID} .go-plant-row>b:nth-of-type(1){color:var(--go-muted);font-weight:400}
    #${PANEL_ID} .go-plant-units{padding:7px 10px;background:var(--go-input);color:var(--go-faint);font-size:11px;font-weight:600}
    #${PANEL_ID} .go-plant-units>b,#${PANEL_ID} .go-plant-units>b:nth-of-type(1){color:var(--go-faint);font-weight:600}
    #${PANEL_ID} .go-plant-row:not(.go-plant-units){padding-left:10px;padding-right:10px}
    /* Footer: the headline number */
    #${PANEL_ID} .go-footer{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;color:var(--go-muted);font-size:12px;font-weight:500}
    #${PANEL_ID} .go-footer span{display:flex;align-items:center;gap:8px}
    #${PANEL_ID} .go-footer span small{padding:2px 8px;border-radius:999px;background:rgba(62,207,142,.12);color:var(--go-green);font-size:11px;font-weight:600}
    #${PANEL_ID} .go-footer b{color:var(--go-gold);font:700 21px/1 var(--go-font);letter-spacing:-.01em;font-variant-numeric:tabular-nums}
    /* Settings card */
    #${PANEL_ID} .go-config-tabs{display:grid;grid-auto-columns:1fr;grid-auto-flow:column;gap:2px;position:sticky;top:0;z-index:1;margin:0 -14px 4px;padding:12px 14px 10px;background:var(--go-bg)}
    #${PANEL_ID} .go-config-tabs::before{content:'';position:absolute;inset:12px 14px 10px;z-index:-1;border:1px solid var(--go-line);border-radius:10px;background:var(--go-input)}
    #${PANEL_ID} .go-config-tabs button{margin:3px 0;padding:6px 4px;border-color:transparent;background:transparent;color:var(--go-muted);font-size:12px;font-weight:500}
    #${PANEL_ID} .go-config-tabs button:first-child{margin-left:3px}
    #${PANEL_ID} .go-config-tabs button:last-child{margin-right:3px}
    #${PANEL_ID} .go-config-tabs button:hover{border-color:transparent;background:rgba(255,255,255,.03);color:var(--go-text)}
    #${PANEL_ID} .go-config-tabs button[data-active=true]{color:var(--go-strong);border-color:var(--go-line-strong);background:var(--go-surface-3);box-shadow:0 1px 2px rgba(0,0,0,.35)}
    #${PANEL_ID} .go-filter{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:5px;max-height:250px;margin:8px 0 12px;overflow:auto}
    #${PANEL_ID} .go-filter label{display:flex;align-items:center;gap:6px;padding:7px;border:1px solid var(--go-line);border-radius:8px;background:var(--go-surface);color:var(--go-text);cursor:pointer}
    #${PANEL_ID} .go-filter label:hover{border-color:var(--go-line-strong)}
    #${PANEL_ID} .go-tools{display:flex;align-items:center;gap:6px;margin:0 0 8px}
    #${PANEL_ID} .go-tools button{flex:1}
    #${PANEL_ID} .go-search{width:100%;height:32px;margin-bottom:8px;padding:0 11px;border:1px solid var(--go-line-strong);border-radius:7px;outline:none;background:var(--go-input);color:var(--go-text);font:13px var(--go-font);transition:border-color .12s,box-shadow .12s}
    #${PANEL_ID} .go-search::placeholder{color:rgba(255,255,255,.5)}
    #${PANEL_ID} .go-search:focus{border-color:var(--go-accent-line);box-shadow:0 0 0 3px rgba(124,108,242,.16)}
    #${PANEL_ID} .go-pill-list{max-height:320px;overflow:auto}
    #${PANEL_ID} .go-pill-section{margin:10px 0}
    #${PANEL_ID} .go-pill-section>b{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;color:var(--go-muted);font-size:12px;font-weight:500}
    #${PANEL_ID} .go-pill-section>b button{min-height:24px;padding:3px 8px;font-size:11px}
    #${PANEL_ID} .go-pill-section>b em{color:var(--go-faint);font-size:11px;font-style:normal;font-weight:400}
    #${PANEL_ID} .go-pill-section>div{display:flex;flex-wrap:wrap;gap:4px}
    #${PANEL_ID} button.go-pill{display:inline-flex;align-items:center;gap:5px;min-height:28px;padding:4px 10px;border:1px solid var(--go-line);border-radius:999px;background:var(--go-surface);color:var(--go-text);font-size:12px;white-space:nowrap}
    #${PANEL_ID} button.go-pill:hover{border-color:var(--go-line-strong);background:var(--go-surface-2)}
    #${PANEL_ID} button.go-pill.on{color:var(--go-strong);border-color:var(--go-accent-line);background:var(--go-accent-soft)}
    #${PANEL_ID} button.go-pill i{width:9px;flex:0 0 9px;color:var(--go-accent-text);font-size:10px;font-style:normal;text-align:center}
    #${PANEL_ID} button.go-pill small{color:var(--go-muted);font-size:11px}
    #${PANEL_ID} .go-muted{margin:0 0 10px;color:var(--go-muted);font-size:12px;line-height:1.45}
    #${PANEL_ID} .go-config-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 0;border-top:1px solid var(--go-line);font-size:13px}
    #${PANEL_ID} .go-config-row:first-child{border-top:none}
    #${PANEL_ID} .go-config-row>span{min-width:0}
    #${PANEL_ID} .go-config-row>span>b{color:var(--go-strong);font-variant-numeric:tabular-nums}
    #${PANEL_ID} .go-config-row select{max-width:150px;height:30px;padding:0 8px;border:1px solid var(--go-line-strong);border-radius:7px;background:var(--go-input);color:var(--go-text);font:12px var(--go-font);cursor:pointer;outline:none}
    #${PANEL_ID} .go-config-row select:focus{border-color:var(--go-accent-line)}
    #${PANEL_ID} .go-config-row select:disabled{opacity:.5;cursor:default}
    #${PANEL_ID} .go-config-row input[type=range]{width:120px;flex:0 0 120px;accent-color:var(--go-accent)}
    /* Pick-one choices as a segmented control rather than loose pills. */
    #${PANEL_ID} .go-pill-choice{display:flex;gap:2px;padding:2px;border:1px solid var(--go-line);border-radius:9px;background:var(--go-input)}
    #${PANEL_ID} .go-pill-choice button.go-pill{min-height:24px;padding:3px 9px;border-color:transparent;border-radius:7px;background:transparent;color:var(--go-muted)}
    #${PANEL_ID} .go-pill-choice button.go-pill:hover{color:var(--go-text);background:rgba(255,255,255,.03)}
    #${PANEL_ID} .go-pill-choice button.go-pill.on{color:var(--go-strong);border-color:var(--go-line-strong);background:var(--go-surface-3)}
    #${PANEL_ID} .go-preset-row{display:flex;align-items:center;gap:4px;margin:6px 0 2px}
    #${PANEL_ID} .go-preset-row .go-search{flex:1;min-width:0;height:30px;margin:0}
    #${PANEL_ID} .go-preset-row button{flex:0 0 auto;height:30px}
    #${PANEL_ID} button.go-pill.go-pill-icon{width:36px;height:36px;padding:0;justify-content:center;border-radius:9px}
    #${PANEL_ID} button.go-pill.go-pill-icon img{width:24px;height:24px;object-fit:contain;image-rendering:auto;opacity:.45}
    #${PANEL_ID} button.go-pill.go-pill-icon span{max-width:32px;overflow:hidden;color:var(--go-muted);font-size:9px;font-weight:700;text-overflow:ellipsis}
    #${PANEL_ID} button.go-pill.go-pill-icon:hover img{opacity:.8}
    #${PANEL_ID} button.go-pill.go-pill-icon.on img{opacity:1}
    #${PANEL_ID} button.go-pill.go-pill-icon.on span{color:var(--go-accent-text)}
    #${PANEL_ID} .go-pill-group:first-child .go-settings-head{margin-top:4px;padding-top:0;border-top:none}
    #${PANEL_ID} .go-settings-head{display:flex;align-items:center;gap:8px;margin:16px 0 4px;padding-top:12px;border-top:1px solid var(--go-line);color:var(--go-faint);font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase}
    #${PANEL_ID} .go-settings-head>span{flex:1}
    #${PANEL_ID} .go-settings-head>em,#${PANEL_ID} .go-settings-head>button{flex:0 0 auto;font-style:normal}
    #${PANEL_ID} .go-settings-head>em{padding:1px 7px;border-radius:999px;background:var(--go-surface-2);color:var(--go-text);font-size:11px;font-weight:600;letter-spacing:0;text-transform:none}
    #${PANEL_ID} .go-settings-head>button{min-height:24px;padding:3px 9px;font-size:11px;letter-spacing:0;text-transform:none}
    /* One switch everywhere a setting is on or off, instead of checkboxes next to check-marked pills. */
    #${PANEL_ID} .go-switch{appearance:none;-webkit-appearance:none;position:relative;width:34px;height:20px;flex:0 0 34px;margin:0;border:0;border-radius:999px;background:var(--go-surface-3);box-shadow:inset 0 0 0 1px var(--go-line);cursor:pointer;transition:background .18s}
    #${PANEL_ID} .go-switch::after{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#d4d4d8;box-shadow:0 1px 3px rgba(0,0,0,.4);transition:transform .18s,background .18s}
    #${PANEL_ID} .go-switch:checked{background:var(--go-accent);box-shadow:none}
    #${PANEL_ID} .go-switch:checked::after{transform:translateX(14px);background:var(--go-strong)}
    #${PANEL_ID} .go-switch:focus-visible{outline:2px solid var(--go-accent-line);outline-offset:2px}
    #${PANEL_ID} .go-config-row>span>small{display:block;margin-top:2px;color:var(--go-muted);font-size:12px;font-weight:400;letter-spacing:0}
    #${PANEL_ID} .go-config-row:has(.go-switch){cursor:pointer}
    #${PANEL_ID} button.go-pill.go-pill-plant{max-width:100%;padding:3px 9px 3px 5px}
    #${PANEL_ID} button.go-pill.go-pill-plant img,#${PANEL_ID} button.go-pill.go-pill-plant .go-plant-blank{width:20px;height:20px;flex:0 0 20px;object-fit:contain;image-rendering:auto;opacity:.7}
    #${PANEL_ID} button.go-pill.go-pill-plant.on img{opacity:1}
    #${PANEL_ID} button.go-pill.go-pill-plant>span{overflow:hidden;text-overflow:ellipsis}
    #${PANEL_ID} button.go-pill.go-pill-plant>small{padding:0 6px;border-radius:999px;background:var(--go-surface-3);color:var(--go-text);font-weight:600}
    #${PANEL_ID} .go-focus-summary{margin:12px 0 2px;padding:10px 12px;border:1px solid var(--go-accent-line);border-radius:10px;background:rgba(124,108,242,.08);color:var(--go-text);font-size:12px;line-height:1.5}
    #${PANEL_ID} .go-focus-summary b{color:var(--go-accent-text);font-weight:600}
    #${PANEL_ID} .go-focus-summary[data-off]{border-color:var(--go-line);background:var(--go-surface);color:var(--go-muted)}
    #${PANEL_ID} .go-focus-summary[data-off] b{color:var(--go-text)}
    @media(max-width:760px){#${PANEL_ID}{padding:6px}#${PANEL_ID} .go-stage{max-height:100%;flex-direction:column;overflow:auto}#${PANEL_ID} .go-card{width:min(344px,94vw)}#${PANEL_ID} .go-config-card{width:min(300px,94vw)}#${PANEL_ID} header .go-actions{gap:0}}
  `;
  document.head.appendChild(style);
}
