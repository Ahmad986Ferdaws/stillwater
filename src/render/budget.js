// Keeps the laptop cool.
//  • Frame cap: on 120 Hz screens the browser would happily render 120 frames a second; a calm
//    walking game looks the same at 60 (or 30 in battery-saver), for half the GPU work.
//  • Real GPU timing (EXT_disjoint_timer_query_webgl2) feeds a dynamic resolution scale, so the
//    GPU stays inside a budget instead of running flat out on big fullscreen displays.
//  • Menus (title / rest screen) render at a lower rate.

export function createBudget(renderer) {
  const gl = renderer.getContext();
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const pending = [];
  let active = null;
  let last = -1e9;
  const st = {
    scale: 1, min: 0.6, max: 1,
    ema: null, gpuMs: null, cooldown: 1.5,
    slow: 0, frames: 0,
  };

  function poll() {
    for (let i = pending.length - 1; i >= 0; i--) {
      const q = pending[i];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) continue;
      const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
      const ms = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
      gl.deleteQuery(q);
      pending.splice(i, 1);
      if (disjoint || !(ms > 0) || ms > 200) continue;
      st.gpuMs = ms;
      st.ema = st.ema == null ? ms : st.ema + (ms - st.ema) * 0.08;
    }
  }

  return {
    get scale() { return st.scale; },
    get gpuMs() { return st.ema; },
    hasTimer: !!ext,

    // Frame cap: returns true when this display refresh should draw a frame.
    shouldRender(now, fps) {
      if (now - last < 1000 / fps - 2.5) return false;
      last = now;
      return true;
    },

    begin() {
      if (!ext) return;
      poll();
      if (pending.length > 5) return; // GPU far behind; don't pile up queries
      active = gl.createQuery();
      gl.beginQuery(ext.TIME_ELAPSED_EXT, active);
    },
    end() {
      if (!active) return;
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      pending.push(active);
      active = null;
    },

    // Safety net for resolution: only drop it when frames are genuinely late (the GPU cannot hold
    // the frame rate), and creep back up after a long stretch of on-time frames. GPU timer values
    // are shown for information only: Apple GPUs clock down under light load, so a "slow" frame
    // time there usually means the GPU is idling at a low clock, not that it is overworked.
    adapt(dt, frameMs, targetMs) {
      st.cooldown -= dt;
      if (typeof document !== 'undefined' && (document.visibilityState !== 'visible' || !document.hasFocus())) return false;
      if (frameMs > targetMs * 1.35) st.slow += dt; else st.slow = Math.max(0, st.slow - dt * 0.5);
      st.onTime = frameMs < targetMs * 1.12 ? (st.onTime || 0) + dt : 0;
      if (st.cooldown > 0) return false;
      const prev = st.scale;
      if (st.slow > 1.5 && st.scale > st.min) {
        st.scale = Math.max(st.min, st.scale - 0.1);
        st.cooldown = 2;
      } else if (st.onTime > 12 && st.scale < st.max) {
        st.scale = Math.min(st.max, st.scale + 0.05);
        st.cooldown = 4;
        st.onTime = 0;
      }
      st.scale = Math.round(st.scale * 100) / 100;
      if (st.scale !== prev) { st.slow = 0; return true; }
      return false;
    },

    reset(max = 1) { st.scale = max; st.max = max; st.slow = 0; st.onTime = 0; st.cooldown = 1.5; },
  };
}
