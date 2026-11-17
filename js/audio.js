(() => {
  const SPEEDS = ['0.75', '1', '1.25', '1.5', '1.75', '2'];
  const STORAGE_KEY = 'klise-audio-speed';
  const sections = document.querySelectorAll('.post-audio');
  if (!sections.length) return;

  const formatTime = value => {
    const total = Math.max(0, Math.round(Number(value) || 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const rest = String(total % 60).padStart(2, '0');
    return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
  };

  const readSpeed = () => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return saved && SPEEDS.includes(saved) ? saved : '1';
    } catch {
      return '1';
    }
  };

  const saveSpeed = value => {
    try {
      localStorage.setItem(STORAGE_KEY, value);
    } catch {
      /* 隐私模式下写不了 localStorage，忽略 */
    }
  };

  sections.forEach(section => {
    const audio = section.querySelector('audio');
    const toggle = section.querySelector('.post-audio__toggle');
    const track = section.querySelector('.post-audio__track');
    const elapsed = section.querySelector('.post-audio__elapsed');
    const total = section.querySelector('.post-audio__total');
    const speed = section.querySelector('.post-audio__speed-select');
    if (!audio || !toggle || !track) return;

    const paint = () => {
      const duration = Number(audio.duration);
      const current = Math.min(Number(audio.currentTime) || 0, Number.isFinite(duration) ? duration : 0);
      if (Number.isFinite(duration) && duration > 0) track.max = String(duration);
      track.value = String(current);
      track.disabled = !(Number.isFinite(duration) && duration > 0);
      if (elapsed) elapsed.textContent = formatTime(current);
      if (total && Number.isFinite(duration) && duration > 0) total.textContent = formatTime(duration);
      const percent = Number.isFinite(duration) && duration > 0 ? `${(current / duration) * 100}%` : '0%';
      track.style.setProperty('--ap-progress', percent);
    };

    const setPlaying = playing => {
      toggle.setAttribute('aria-pressed', String(playing));
      toggle.setAttribute('aria-label', playing ? '暂停朗读' : '播放朗读');
      section.classList.toggle('is-playing', playing);
    };

    const setSpeed = value => {
      const next = SPEEDS.includes(String(value)) ? String(value) : '1';
      audio.playbackRate = Number(next);
      audio.defaultPlaybackRate = Number(next);
      if (speed) speed.value = next;
    };

    const fail = () => {
      section.classList.add('is-error');
      if (total) total.textContent = '音频加载失败';
      setPlaying(false);
    };

    setSpeed(readSpeed());
    section.classList.add('is-ready');

    toggle.addEventListener('click', () => {
      if (audio.paused) {
        const started = audio.play();
        if (started && typeof started.catch === 'function') {
          started.catch(fail);
        }
      } else {
        audio.pause();
      }
    });

    audio.addEventListener('play', () => setPlaying(true));
    audio.addEventListener('pause', () => setPlaying(false));
    audio.addEventListener('loadedmetadata', paint);
    audio.addEventListener('durationchange', paint);
    audio.addEventListener('timeupdate', paint);
    audio.addEventListener('ended', () => {
      setPlaying(false);
      paint();
    });
    audio.addEventListener('error', fail);

    track.addEventListener('input', () => {
      const next = Number(track.value);
      if (Number.isFinite(next)) audio.currentTime = next;
      paint();
    });

    if (speed) {
      speed.addEventListener('change', () => {
        setSpeed(speed.value);
        saveSpeed(speed.value);
      });
    }

    if ('mediaSession' in navigator) {
      const main = section.closest('main') || document;
      const heading = main.querySelector('h1');
      const author = main.querySelector('[itemprop="author"] [itemprop="name"]');
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: heading ? heading.textContent.trim() : document.title,
          artist: author ? author.textContent.trim() : '',
          album: document.title
        });
        const actions = {
          play: () => audio.play(),
          pause: () => audio.pause(),
          seekbackward: details => { audio.currentTime = Math.max(0, audio.currentTime - (details?.seekOffset || 10)); },
          seekforward: details => { audio.currentTime = Math.min(Number(audio.duration) || Infinity, audio.currentTime + (details?.seekOffset || 10)); },
          seekto: details => { if (details?.seekTime != null) audio.currentTime = details.seekTime; }
        };
        for (const [action, handler] of Object.entries(actions)) {
          try {
            navigator.mediaSession.setActionHandler(action, handler);
          } catch {
            /* 浏览器不支持该操作 */
          }
        }
      } catch {
        /* MediaSession 不可用，忽略 */
      }
    }
  });
})();
