/**
 * NQ Shoppable Videos
 * Carousel with inline HLS autoplay + fullscreen modal + add-to-cart
 */

(function () {
  'use strict';

  // ─── Modal singleton state ──────────────────────────────────────────
  let modalVideos = [];
  let modalIndex = 0;
  let modalInitialized = false;

  // ─── Per-card HLS instances ─────────────────────────────────────────
  const cardHlsMap = new WeakMap();

  // ─── HLS.js — loaded once at boot, shared everywhere ────────────────
  let HlsLib = null;
  let hlsLoadPromise = null;

  function loadHls() {
    if (HlsLib) return Promise.resolve(HlsLib);
    if (hlsLoadPromise) return hlsLoadPromise;
    hlsLoadPromise = new Promise((resolve) => {
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js';
      script.onload = () => { HlsLib = window.Hls; resolve(HlsLib); };
      script.onerror = () => resolve(null);
      document.head.appendChild(script);
    });
    return hlsLoadPromise;
  }

  // ─── Swiper.js — loaded once, used by modal ──────────────────────────
  let SwiperLib = null;
  let swiperLoadPromise = null;

  function loadSwiper() {
    if (SwiperLib) return Promise.resolve(SwiperLib);
    if (swiperLoadPromise) return swiperLoadPromise;
    swiperLoadPromise = new Promise((resolve) => {
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/swiper@11/swiper-bundle.min.js';
      script.onload = () => { SwiperLib = window.Swiper; resolve(SwiperLib); };
      script.onerror = () => resolve(null);
      document.head.appendChild(script);
    });
    return swiperLoadPromise;
  }

  // ─── Utility ────────────────────────────────────────────────────────
  function formatPrice(amount, currency) {
    try {
      return new Intl.NumberFormat('en-IN', {
        style: 'currency',
        currency: currency || 'INR',
        maximumFractionDigits: 0,
      }).format(amount);
    } catch {
      return amount ? `Rs. ${amount}` : '';
    }
  }

  // ─── Attach HLS or MP4 to a video element ───────────────────────────
  function attachStream(videoEl, src, isHls, onReady) {
    if (isHls && videoEl.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari — native HLS
      videoEl.src = src;
      onReady();
    } else if (isHls && HlsLib && HlsLib.isSupported()) {
      // Chrome / Firefox — HLS.js
      const hls = new HlsLib({
        startLevel: -1,       // auto quality
        maxBufferLength: 10,  // buffer 10s max (saves memory)
      });
      hls.loadSource(src);
      hls.attachMedia(videoEl);
      hls.on(HlsLib.Events.MANIFEST_PARSED, onReady);
      return hls; // caller stores this
    } else {
      // Plain MP4 fallback
      videoEl.src = src;
      onReady();
    }
    return null;
  }

  // ─── Carousel video suspension ──────────────────────────────────────────
  // While the modal is open the carousel is hidden behind it, but its videos
  // keep playing/buffering and compete for the browser's limited connections
  // to the video host. Pause them on open, resume the visible ones on close.
  function pauseCarouselVideos() {
    document.querySelectorAll('.nq-shoppable-carousel .nq-inline-video').forEach((v) => {
      try { v.pause(); } catch (e) {}
    });
  }

  function resumeCarouselVideos() {
    const vh = window.innerHeight || 800;
    document.querySelectorAll('.nq-shoppable-carousel .nq-inline-video').forEach((v) => {
      const r = v.getBoundingClientRect();
      const visible = r.width > 0 && r.bottom > 0 && r.top < vh;
      // Only resume cards that were actually playing and are still on screen.
      if (visible && (v.getAttribute('src') || v.src) && v.classList.contains('nq-playing')) {
        v.play().catch(() => {});
      }
    });
  }

  // ─── Modal (Swiper-powered) ──────────────────────────────────────────────
  function initModal() {
    if (modalInitialized) return;
    modalInitialized = true;

    const modal        = document.getElementById('nq-modal');
    const bg           = document.getElementById('nq-modal-bg');
    const closeBtn     = document.getElementById('nq-close-btn');
    const counter      = document.getElementById('nq-counter');
    const muteBtn      = document.getElementById('nq-mute-btn');
    const iconSound    = document.getElementById('nq-icon-sound');
    const iconMuted    = document.getElementById('nq-icon-muted');
    const peekPrev     = document.getElementById('nq-peek-prev');
    const peekNext     = document.getElementById('nq-peek-next');
    const peekPrevImg  = document.getElementById('nq-peek-prev-img');
    const peekNextImg  = document.getElementById('nq-peek-next-img');
    const arrowPrev    = document.getElementById('nq-arrow-prev');
    const arrowNext    = document.getElementById('nq-arrow-next');
    const likeBtn      = document.getElementById('nq-like-btn');
    const shareBtn     = document.getElementById('nq-share-btn');
    const swiperWrapper = document.getElementById('nq-swiper-wrapper');

    if (!modal || !swiperWrapper) return;

    let swiperInstance = null;
    let slotMap        = {};   // slideIndex → { video, hls } currently mounted
    let videoPool      = [];   // small set of reusable <video> elements (created once)
    let isMuted        = true;
    const likedSet     = new Set(); // video ids the user has "liked" (visual toggle)
    // Only the active slide + immediate neighbours get a real <video>. Browsers
    // cap the number of media players per page and connections per origin, so we
    // never create one <video> per library item — we recycle a tiny pool.
    // PRELOAD_RANGE 1 = active + next + prev, which keeps the next video instant.
    const PRELOAD_RANGE = 1;

    // ── Helpers ───────────────────────────────────────────────────────────
    // Desktop (>700px) slides left/right; mobile (<=700px) stays a vertical
    // TikTok-style reel. 700px matches the CSS mobile breakpoint.
    function getModalDirection() {
      return window.matchMedia('(max-width: 700px)').matches ? 'vertical' : 'horizontal';
    }

    function getSlideVideo(index) {
      const slide = swiperWrapper.children[index];
      return slide ? slide.querySelector('.nq-slide-video') : null;
    }

    // Reveal the video by fading it in OVER the thumbnail — only ever called
    // once a real frame is actually painted (playing/loadeddata), never at
    // MANIFEST_PARSED. This is what kills the black flash.
    function revealSlide(index) {
      const slide = swiperWrapper.children[index];
      if (!slide) return;
      slide.classList.remove('nq-loading');
      const videoEl = slide.querySelector('.nq-slide-video');
      if (videoEl) videoEl.classList.add('nq-playing');
      const thumb = slide.querySelector('.nq-slide-thumb');
      if (thumb) thumb.classList.add('nq-slide-thumb-hidden');
    }

    // Put a slide back to its thumbnail state (used when a slide goes idle or
    // its buffer is freed) so revisiting it shows the thumbnail, never black.
    function resetSlide(index) {
      const slide = swiperWrapper.children[index];
      if (!slide) return;
      slide.classList.remove('nq-loading');
      slide.classList.remove('nq-paused');
      const videoEl = slide.querySelector('.nq-slide-video');
      if (videoEl) videoEl.classList.remove('nq-playing');
      const thumb = slide.querySelector('.nq-slide-thumb');
      if (thumb) thumb.classList.remove('nq-slide-thumb-hidden');
    }

    // Show/hide the tap-to-play button on a slide. The play overlay is the
    // reliable fallback for whenever autoplay is blocked or the video is paused
    // — the user can always tap to start it (the approach Quinn relies on).
    function setSlidePaused(index, isPaused) {
      const slide = swiperWrapper.children[index];
      if (slide) slide.classList.toggle('nq-paused', isPaused);
    }

    // Play the active slide and reveal it the instant it has a real frame.
    function playSlide(index) {
      const videoEl = getSlideVideo(index);
      if (!videoEl) return;
      const slide = swiperWrapper.children[index];
      videoEl.muted = isMuted;

      const stillActive = () => swiperInstance && swiperInstance.activeIndex === index;

      const tryPlay = () => {
        if (!stillActive()) return;
        const p = videoEl.play();
        if (p && p.then) {
          // Success → hide the play button. Failure (AbortError mid-load, or
          // autoplay blocked) → show the play button so a tap can start it.
          p.then(() => setSlidePaused(index, false))
           .catch(() => { if (videoEl.paused) setSlidePaused(index, true); });
        }
      };

      // Reveal once a real frame exists, AND retry play() if it's still paused.
      // The first play() during the rapid open sequence can be aborted
      // (AbortError) before playback starts; without this retry the video loads
      // but stays frozen on the first frame. Retrying on loadeddata/canplay —
      // when loading has settled — reliably starts it.
      const onReady = () => {
        if (!stillActive()) return;
        revealSlide(index);
        if (videoEl.paused) tryPlay();
      };

      if (videoEl.readyState >= 2) {
        tryPlay();
        onReady();
      } else {
        // Still buffering — keep the thumbnail up (with spinner) until ready.
        if (slide) slide.classList.add('nq-loading');
        videoEl.addEventListener('loadeddata', onReady, { once: true });
        videoEl.addEventListener('canplay', onReady, { once: true });
        videoEl.addEventListener('playing', () => { if (stillActive()) revealSlide(index); }, { once: true });
        tryPlay();
      }
    }

    // ── Virtualised video pool ──────────────────────────────────────────────
    // Browsers cap how many <video> players a page can have, and how many
    // connections an origin allows. So instead of one <video> per library item,
    // we keep a tiny pool of reusable elements and mount them into the active
    // slide + its neighbours, re-pointing the source as the user navigates. The
    // number of media players stays at POOL_SIZE no matter how big the library
    // is or how many times the modal is opened — which removes the ceiling that
    // caused videos to stall at readyState 0 / freeze the tab.
    const POOL_SIZE = 3; // must be >= 2 * PRELOAD_RANGE + 1

    function currentSlideIndexOf(video) {
      const slide = video.closest('.nq-video-slide');
      return slide ? Array.prototype.indexOf.call(swiperWrapper.children, slide) : -1;
    }

    function buildPool() {
      if (videoPool.length) return;
      for (let i = 0; i < POOL_SIZE; i++) {
        const v = document.createElement('video');
        v.className = 'nq-slide-video';
        v.muted = true;
        v.loop = true;
        v.setAttribute('playsinline', '');
        v.setAttribute('webkit-playsinline', '');
        v.setAttribute('muted', '');
        v.preload = 'auto';
        // Tap-to-play button stays in sync with whichever slide this video is in.
        v.addEventListener('play',  () => { const i = currentSlideIndexOf(v); if (i >= 0) setSlidePaused(i, false); });
        v.addEventListener('pause', () => { const i = currentSlideIndexOf(v); if (!v.ended && i >= 0 && swiperInstance && swiperInstance.activeIndex === i) setSlidePaused(i, true); });
        videoPool.push(v);
      }
    }

    function freePoolVideo() {
      const used = new Set(Object.values(slotMap).map((s) => s.video));
      return videoPool.find((v) => !used.has(v)) || null;
    }

    // Mount a reused <video> into a slide and point it at that slide's source.
    function assignSlot(index) {
      if (slotMap[index]) return; // already mounted — keep its buffer
      const v = modalVideos[index];
      const slide = swiperWrapper.children[index];
      if (!v || !slide) return;
      const video = freePoolVideo();
      if (!video) return;
      video.classList.remove('nq-playing');
      slide.insertBefore(video, slide.firstChild); // sits behind thumb/overlay
      const src   = v.streamUrl || v.videoUrl;
      const isHls  = !!(v.streamUrl);
      // Source attached here; playback is driven by playSlide() (which retries
      // on canplay), so we don't call play() in the ready callback.
      const hls = attachStream(video, src, isHls, () => {});
      slotMap[index] = { video, hls: hls || null };
    }

    // Pull the <video> back out of a slide and free it for reuse elsewhere.
    function releaseSlot(index) {
      const slot = slotMap[index];
      if (!slot) return;
      const { video, hls } = slot;
      if (hls) { try { hls.destroy(); } catch (e) {} }
      try { video.pause(); } catch (e) {}
      video.removeAttribute('src');
      try { video.load(); } catch (e) {}
      if (video.parentNode) video.parentNode.removeChild(video);
      delete slotMap[index];
      resetSlide(index); // back to thumbnail
    }

    function releaseAllSlots() {
      Object.keys(slotMap).map(Number).forEach(releaseSlot);
    }

    function manageSlides(activeIndex) {
      const total = modalVideos.length;
      const win = new Set();
      for (let i = Math.max(0, activeIndex - PRELOAD_RANGE); i <= Math.min(total - 1, activeIndex + PRELOAD_RANGE); i++) {
        win.add(i);
      }
      // Release slots outside the window FIRST so their videos are free to reuse
      Object.keys(slotMap).map(Number).forEach((idx) => { if (!win.has(idx)) releaseSlot(idx); });
      // Mount a pooled video into each slide in the window
      win.forEach((idx) => assignSlot(idx));
      // Play the active one; pause + thumbnail the neighbours
      win.forEach((idx) => {
        if (idx === activeIndex) {
          playSlide(idx);
        } else {
          const vEl = getSlideVideo(idx);
          if (vEl) vEl.pause();
          resetSlide(idx);
        }
      });
    }

    function updateUI(index) {
      const v = modalVideos[index];
      if (!v) return;

      if (counter) counter.textContent = (index + 1) + ' / ' + modalVideos.length;

      const prevV = modalVideos[index - 1];
      const nextV = modalVideos[index + 1];
      if (peekPrev)    peekPrev.dataset.hidden    = prevV ? 'false' : 'true';
      if (peekPrevImg && prevV) { peekPrevImg.src = prevV.thumbnailUrl || ''; peekPrevImg.alt = prevV.productTitle || ''; }
      if (arrowPrev)   arrowPrev.dataset.hidden   = prevV ? 'false' : 'true';
      if (peekNext)    peekNext.dataset.hidden    = nextV ? 'false' : 'true';
      if (peekNextImg && nextV) { peekNextImg.src = nextV.thumbnailUrl || ''; peekNextImg.alt = nextV.productTitle || ''; }
      if (arrowNext)   arrowNext.dataset.hidden   = nextV ? 'false' : 'true';

      const card = document.getElementById('nq-product-card');
      if (!card) return;

      // claura-style product card: image + name + price, with a SHOP NOW
      // button that links straight to the product page.
      card.innerHTML = `
        <div class="nq-prod-card">
          ${v.productImageUrl
            ? `<img class="nq-prod-img" src="${v.productImageUrl}" alt="${v.productTitle || ''}" loading="lazy">`
            : '<div class="nq-prod-img nq-prod-img-ph"></div>'}
          <div class="nq-prod-info">
            <p class="nq-prod-name">${v.productTitle || 'View Product'}</p>
            <div class="nq-prod-prices">
              ${v.price ? `<span class="nq-prod-price">${formatPrice(v.price, v.currency)}</span>` : ''}
              ${v.compareAtPrice ? `<span class="nq-prod-compare">${formatPrice(v.compareAtPrice, v.currency)}</span>` : ''}
            </div>
          </div>
        </div>
        <a class="nq-shop-now" href="${v.productUrl || '#'}">Shop Now</a>
      `;

      // Reflect the like state for the current video
      if (likeBtn) likeBtn.classList.toggle('nq-liked', likedSet.has(v.id));
    }

    // ── Open / Close ──────────────────────────────────────────────────────
    function openModal(videos, index) {
      modalVideos = videos;
      modalIndex  = index;
      modal.style.display = 'flex';
      document.body.style.overflow = 'hidden';
      document.body.classList.add('nq-modal-open');

      // Free up connections for the modal videos.
      pauseCarouselVideos();

      // Build a lightweight, thumbnail-only slide per video — NO <video> here.
      // The actual <video> elements come from a small reusable pool and are
      // mounted into the active slide + neighbours by manageSlides(). This keeps
      // the media-player count tiny regardless of how many videos exist.
      swiperWrapper.innerHTML = videos.map((v) => `
        <div class="swiper-slide nq-video-slide">
          ${v.thumbnailUrl ? `<img class="nq-slide-thumb" src="${v.thumbnailUrl}" alt="">` : ''}
          <div class="nq-video-loading"><div class="nq-spinner"></div></div>
          <button class="nq-play-overlay" aria-label="Play video" tabindex="-1">
            <svg width="30" height="30" viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z"/></svg>
          </button>
        </div>
      `).join('');

      buildPool(); // create the reusable <video> elements once

      // Init Swiper (loads from CDN on first open)
      loadSwiper().then((Swiper) => {
        if (!Swiper) return;
        // Construct WITHOUT event handlers first, then assign swiperInstance.
        // With a non-zero initialSlide, Swiper fires slideChange DURING
        // construction; if the handler ran then it would reference an
        // unassigned swiperInstance, throw, and abort setup (no videos mount,
        // navigation dead). Attaching handlers after assignment avoids that and
        // they won't fire for the initial slide.
        swiperInstance = new Swiper('#nq-video-swiper', {
          direction: getModalDirection(),
          speed: 280,
          initialSlide: index,
          grabCursor: true,
          resistanceRatio: 0.6,
        });

        // Fire during the swipe animation — start buffering the incoming video
        swiperInstance.on('slideChangeTransitionStart', () => {
          modalIndex = swiperInstance.activeIndex;
          manageSlides(modalIndex);
        });
        // Fire after animation completes — keep counter/product panel in sync
        swiperInstance.on('slideChange', () => {
          modalIndex = swiperInstance.activeIndex;
          updateUI(modalIndex);
          iconMuted.style.display = isMuted ? 'block' : 'none';
          iconSound.style.display  = isMuted ? 'none'  : 'block';
        });

        updateUI(index);
        manageSlides(index);
      });
    }

    function closeModal() {
      modal.style.display = 'none';
      document.body.style.overflow = '';
      document.body.classList.remove('nq-modal-open');
      // Detach pooled videos and clear their sources (keeps the pool for reuse).
      releaseAllSlots();
      if (swiperInstance) { swiperInstance.destroy(true, true); swiperInstance = null; }
      swiperWrapper.innerHTML = '';

      // Resume the carousel now that the modal's videos are idle.
      resumeCarouselVideos();
    }

    // ── Event listeners ──────────────────────────────────────────────────
    bg.addEventListener('click', closeModal);
    closeBtn.addEventListener('click', closeModal);

    // Tap the video (or the play button) to toggle play/pause — the reliable
    // way to start a video whenever autoplay didn't. Swiper only emits a click
    // on a tap (not a drag/swipe), so this doesn't interfere with navigation.
    swiperWrapper.addEventListener('click', (e) => {
      const slide = e.target.closest('.nq-video-slide');
      if (!slide) return;
      const idx = Array.prototype.indexOf.call(swiperWrapper.children, slide);
      const videoEl = getSlideVideo(idx);
      if (!videoEl) return;
      if (e.target.closest('.nq-play-overlay') || videoEl.paused) {
        videoEl.muted = isMuted;
        const p = videoEl.play();
        if (p && p.catch) p.catch(() => {});
      } else {
        videoEl.pause();
      }
    });

    if (peekPrev)  peekPrev.addEventListener('click',  () => swiperInstance?.slidePrev());
    if (peekNext)  peekNext.addEventListener('click',  () => swiperInstance?.slideNext());
    if (arrowPrev) arrowPrev.addEventListener('click', () => swiperInstance?.slidePrev());
    if (arrowNext) arrowNext.addEventListener('click', () => swiperInstance?.slideNext());

    muteBtn.addEventListener('click', () => {
      isMuted = !isMuted;
      iconMuted.style.display = isMuted ? 'block' : 'none';
      iconSound.style.display  = isMuted ? 'none'  : 'block';
      const activeVideo = getSlideVideo(swiperInstance?.activeIndex ?? 0);
      if (activeVideo) activeVideo.muted = isMuted;
    });

    document.addEventListener('keydown', (e) => {
      if (modal.style.display === 'none' || !swiperInstance) return;
      if (e.key === 'Escape')     closeModal();
      if (e.key === 'ArrowUp'   || e.key === 'ArrowLeft')  swiperInstance.slidePrev();
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') swiperInstance.slideNext();
    });

    // Keep the slide direction in sync with viewport size (e.g. window resize
    // or tablet rotation crossing the 700px breakpoint).
    let _nqDirRaf;
    window.addEventListener('resize', () => {
      if (!swiperInstance) return;
      cancelAnimationFrame(_nqDirRaf);
      _nqDirRaf = requestAnimationFrame(() => {
        const want = getModalDirection();
        if (swiperInstance && swiperInstance.params.direction !== want) {
          swiperInstance.changeDirection(want);
        }
      });
    });

    // ── Like (visual toggle, remembered per video for this session) ──────
    if (likeBtn) {
      likeBtn.addEventListener('click', () => {
        const v = modalVideos[modalIndex];
        if (!v) return;
        if (likedSet.has(v.id)) likedSet.delete(v.id); else likedSet.add(v.id);
        likeBtn.classList.toggle('nq-liked', likedSet.has(v.id));
      });
    }

    // ── Share — native share sheet, falling back to copying the product link
    if (shareBtn) {
      shareBtn.addEventListener('click', async () => {
        const v = modalVideos[modalIndex];
        if (!v) return;
        let url = v.productUrl || location.href;
        if (url.charAt(0) === '/') url = location.origin + url;
        if (navigator.share) {
          try { await navigator.share({ title: v.productTitle || document.title, url }); } catch (e) {}
        } else {
          try {
            await navigator.clipboard.writeText(url);
            const label = shareBtn.parentElement && shareBtn.parentElement.querySelector('.nq-side-label');
            if (label) { const o = label.textContent; label.textContent = 'Copied!'; setTimeout(() => { label.textContent = o; }, 1500); }
          } catch (e) {}
        }
      });
    }

    window._nqOpenModal = openModal;
  }

  // ─── Carousel class ─────────────────────────────────────────────────
  class NQCarousel {
    constructor(container) {
      this.container = container;
      this.shop = container.dataset.shop;
      this.videos = [];
      this.observer = null;
      this.init();
    }

    async init() {
      // Load HLS.js in background immediately — ready by the time user scrolls
      loadHls();
      initModal();
      await this.fetchVideos();
      this.render();
      this.addCarouselArrows();
      this.preloadFirstCard();
      this.setupIntersectionObserver();
    }

    // Left/right buttons to scroll the carousel without opening the modal.
    addCarouselArrows() {
      const track = this.container.querySelector('.nq-carousel-track');
      if (!track) return;

      const mkBtn = (cls, label, inner) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'nq-carousel-arrow ' + cls;
        b.setAttribute('aria-label', label);
        b.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">' + inner + '</svg>';
        return b;
      };
      const prev = mkBtn('nq-carousel-arrow-prev', 'Previous videos', '<polyline points="15 18 9 12 15 6"></polyline>');
      const next = mkBtn('nq-carousel-arrow-next', 'More videos', '<polyline points="9 18 15 12 9 6"></polyline>');
      this.container.appendChild(prev);
      this.container.appendChild(next);

      const amount = () => Math.max(220, Math.round(track.clientWidth * 0.85));
      // Manual smooth scroll — native scrollBy({behavior:'smooth'}) is unreliable
      // on snap tracks in some themes, so we animate scrollLeft ourselves.
      const smoothScrollBy = (delta) => {
        const start = track.scrollLeft;
        const target = Math.max(0, Math.min(track.scrollWidth - track.clientWidth, start + delta));
        const dur = 360, t0 = performance.now();
        const step = (t) => {
          const p = Math.min(1, (t - t0) / dur);
          track.scrollLeft = start + (target - start) * (1 - Math.pow(1 - p, 3));
          if (p < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      };
      prev.addEventListener('click', () => smoothScrollBy(-amount()));
      next.addEventListener('click', () => smoothScrollBy(amount()));

      const update = () => {
        const max = track.scrollWidth - track.clientWidth - 4;
        const scrollable = max > 4;
        // Only dim an arrow when the carousel is scrollable AND sitting at that
        // edge. When everything fits (not scrollable) both stay fully visible.
        prev.dataset.hidden = (scrollable && track.scrollLeft <= 4) ? 'true' : 'false';
        next.dataset.hidden = (scrollable && track.scrollLeft >= max) ? 'true' : 'false';
      };
      track.addEventListener('scroll', update, { passive: true });
      window.addEventListener('resize', update);
      setTimeout(update, 150); // re-check once thumbnails have laid out
      update();

      // Reveal the arrows on cursor activity, then auto-hide after a short pause.
      const el = this.container;
      let hideTimer = null;
      const reveal = () => {
        el.classList.add('nq-arrows-visible');
        clearTimeout(hideTimer);
        hideTimer = setTimeout(() => el.classList.remove('nq-arrows-visible'), 2000);
      };
      el.addEventListener('mouseenter', reveal);
      el.addEventListener('mousemove', reveal);
      el.addEventListener('click', reveal);
      el.addEventListener('mouseleave', () => { clearTimeout(hideTimer); el.classList.remove('nq-arrows-visible'); });
    }

    preloadFirstCard() {
      const firstCard = this.container.querySelector('.nq-video-card');
      if (!firstCard) return;
      const videoEl = firstCard.querySelector('.nq-inline-video');
      if (!videoEl || cardHlsMap.has(videoEl)) return;
      const src   = videoEl.dataset.src;
      const isHls = videoEl.dataset.hls === 'true';
      // Attach stream and play immediately — first card should autoplay on page load
      const hls = attachStream(videoEl, src, isHls, () => {
        videoEl.play()
          .then(() => {
            videoEl.classList.add('nq-playing');
            const thumb = firstCard.querySelector('.nq-thumb');
            if (thumb) thumb.classList.add('nq-hidden');
          })
          .catch(() => {});
      });
      if (hls) cardHlsMap.set(videoEl, hls);
    }

    async fetchVideos() {
      try {
        const res = await fetch(`/apps/nq-videos/api/videos`, {
          headers: { 'Accept': 'application/json' },
        });
        if (!res.ok) throw new Error('Failed to fetch videos');
        const data = await res.json();
        this.videos = data.videos || [];
      } catch (err) {
        console.warn('[NQ Shoppable Videos] Could not load videos:', err.message);
        this.videos = [];
      }
    }

    render() {
      const track = this.container.querySelector('.nq-carousel-track');
      if (!track) return;

      if (this.videos.length === 0) {
        track.innerHTML = '<p class="nq-empty">No videos configured yet.</p>';
        return;
      }

      const html = this.videos.map((v, i) => {
        const discount = v.compareAtPrice && v.price
          ? Math.round((1 - v.price / v.compareAtPrice) * 100)
          : null;

        // Prefer HLS stream for inline playback
        const videoSrc = v.streamUrl || v.videoUrl;
        const isHls    = !!(v.streamUrl);

        return `
          <div class="nq-video-card" data-index="${i}" role="button" tabindex="0" aria-label="Play video: ${v.productTitle || v.title || ''}">
            <div class="nq-thumb-wrap">
              ${v.thumbnailUrl
                ? `<img class="nq-thumb" src="${v.thumbnailUrl}" alt="${v.productTitle || ''}" loading="lazy">`
                : '<div class="nq-thumb" style="background:#222;"></div>'}
              <video
                class="nq-inline-video"
                data-src="${videoSrc}"
                data-hls="${isHls}"
                poster="${v.thumbnailUrl || ''}"
                muted
                playsinline
                loop
                preload="none"
              ></video>
              ${v.viewCount ? `
                <div class="nq-view-count">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="white">
                    <path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/>
                  </svg>
                  ${v.viewCount}
                </div>
              ` : ''}
            </div>
            <div class="nq-card-info">
              <p class="nq-card-title">${v.productTitle || v.title || ''}</p>
              <div class="nq-card-prices">
                ${v.price ? `<span class="nq-card-price">${formatPrice(v.price, v.currency)}</span>` : ''}
                ${v.compareAtPrice ? `<span class="nq-card-compare-price">${formatPrice(v.compareAtPrice, v.currency)}</span>` : ''}
                ${discount ? `<span class="nq-card-discount">${discount}% off</span>` : ''}
              </div>
            </div>
          </div>
        `;
      }).join('');

      track.innerHTML = html;

      // Click & keyboard → open modal
      track.querySelectorAll('.nq-video-card').forEach((card) => {
        const open = () => {
          const idx = parseInt(card.dataset.index, 10);
          if (window._nqOpenModal) window._nqOpenModal(this.videos, idx);
          this.trackEvent('VIEW', this.videos[idx]?.id);
        };
        card.addEventListener('click', open);
        card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') open(); });
      });
    }

    setupIntersectionObserver() {
      if (!('IntersectionObserver' in window)) return;

      const track = this.container.querySelector('.nq-carousel-track');

      // Tracks which cards the play observer wants playing.
      // When a stream finishes loading, onReady checks this set and plays immediately
      // if the card was already in view — fixes the race between stream load and observer.
      const shouldPlay = new Set();

      // Stage 1 — preload: start buffering when card is 10% visible
      this.preloadObserver = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          const videoEl = entry.target.querySelector('.nq-inline-video');
          if (!videoEl) return;

          if (entry.isIntersecting) {
            // Already has an HLS instance — nothing to do
            if (cardHlsMap.has(videoEl)) return;

            const src   = videoEl.dataset.src;
            const isHls = videoEl.dataset.hls === 'true';
            const card  = entry.target;

            // Attach stream; when ready, play if the play observer already flagged this card
            const hls = attachStream(videoEl, src, isHls, () => {
              if (shouldPlay.has(card)) {
                videoEl.play()
                  .then(() => {
                    videoEl.classList.add('nq-playing');
                    const thumb = card.querySelector('.nq-thumb');
                    if (thumb) thumb.classList.add('nq-hidden');
                  })
                  .catch(() => {});
              } else {
                videoEl.pause();
              }
            });

            if (hls) cardHlsMap.set(videoEl, hls);

          } else {
            // Left view entirely — destroy to free memory
            const hls = cardHlsMap.get(videoEl);
            if (hls) {
              hls.destroy();
              cardHlsMap.delete(videoEl);
              videoEl.removeAttribute('src');
            }

            const thumb = entry.target.querySelector('.nq-thumb');
            videoEl.pause();
            videoEl.currentTime = 0;
            videoEl.classList.remove('nq-playing');
            if (thumb) thumb.classList.remove('nq-hidden');
          }
        });
      }, { root: track, threshold: 0.1 });

      // Stage 2 — play: call play() when card is 65% visible (already buffered)
      this.observer = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          const card    = entry.target;
          const thumb   = card.querySelector('.nq-thumb');
          const videoEl = card.querySelector('.nq-inline-video');
          if (!videoEl) return;

          if (entry.isIntersecting) {
            shouldPlay.add(card);

            // HLS.js doesn't honour the `loop` attribute on MSE streams —
            // when the last segment ends the video just stops. Fix: restart manually.
            if (!videoEl._nqEndedHandler) {
              videoEl._nqEndedHandler = () => {
                if (shouldPlay.has(card)) {
                  videoEl.currentTime = 0;
                  videoEl.play().catch(() => {});
                }
              };
              videoEl.addEventListener('ended', videoEl._nqEndedHandler);
            }

            // Try play now — succeeds if stream already loaded, otherwise
            // preloadObserver's onReady will pick it up via shouldPlay
            videoEl.play()
              .then(() => {
                videoEl.classList.add('nq-playing');
                if (thumb) thumb.classList.add('nq-hidden');
              })
              .catch(() => {});
          } else {
            shouldPlay.delete(card);
            // Clean up ended handler when card leaves view
            if (videoEl._nqEndedHandler) {
              videoEl.removeEventListener('ended', videoEl._nqEndedHandler);
              delete videoEl._nqEndedHandler;
            }
            videoEl.pause();
            videoEl.classList.remove('nq-playing');
            if (thumb) thumb.classList.remove('nq-hidden');
          }
        });
      }, { root: track, threshold: 0.65 });

      // Resume shouldPlay videos when user switches back to this tab
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) return;
        shouldPlay.forEach((card) => {
          const videoEl = card.querySelector('.nq-inline-video');
          if (videoEl && videoEl.paused) videoEl.play().catch(() => {});
        });
      });

      this.container.querySelectorAll('.nq-video-card').forEach((card) => {
        this.preloadObserver.observe(card);
        this.observer.observe(card);
      });
    }

    trackEvent(type, videoId) {
      if (!videoId) return;
      fetch('/apps/nq-videos/api/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, videoId }),
        keepalive: true,
      }).catch(() => {});
    }
  }

  // ─── Add to Cart ─────────────────────────────────────────────────────
  window.NQShoppable = {
    async addToCart(btn) {
      const variantId = btn.dataset.variant;
      const videoId   = btn.dataset.videoId;
      if (!variantId) return;

      const originalText = btn.textContent;
      btn.textContent = 'Adding…';
      btn.disabled = true;

      try {
        const res = await fetch('/cart/add.js', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: variantId, quantity: 1 }),
        });

        if (res.ok) {
          btn.textContent = 'Added ✓';
          btn.classList.add('nq-added');
          document.dispatchEvent(new CustomEvent('cart:refresh'));
          document.dispatchEvent(new CustomEvent('theme:cart:open'));
          fetch('/apps/nq-videos/api/track', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'ATC', videoId }),
            keepalive: true,
          }).catch(() => {});
        } else {
          btn.textContent = 'Error';
        }
      } catch {
        btn.textContent = 'Error';
      }

      setTimeout(() => {
        btn.textContent = originalText;
        btn.classList.remove('nq-added');
        btn.disabled = false;
      }, 2200);
    },
  };

  // ─── Boot ─────────────────────────────────────────────────────────────
  function boot() {
    document.querySelectorAll('.nq-shoppable-carousel').forEach((el) => {
      if (!el.dataset.nqInit) {
        el.dataset.nqInit = '1';
        new NQCarousel(el);
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})();
