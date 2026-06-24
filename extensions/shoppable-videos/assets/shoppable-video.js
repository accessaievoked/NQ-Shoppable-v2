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
    const swipeHint    = document.getElementById('nq-swipe-hint');
    let   swipeHintTimer = null;
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

    // Load slide thumbnails only near the active slide and free far-away ones.
    // Without this, a large library (e.g. 100+ videos) loads every thumbnail at
    // once when the modal opens, which crashes mobile tabs (the "page refresh").
    const THUMB_WINDOW = 2;
    function manageThumbs(activeIndex) {
      const slides = swiperWrapper.children;
      for (let i = 0; i < slides.length; i++) {
        const img = slides[i].querySelector('.nq-slide-thumb');
        if (!img) continue;
        if (Math.abs(i - activeIndex) <= THUMB_WINDOW) {
          if (!img.getAttribute('src') && img.dataset.src) img.src = img.dataset.src;
        } else if (img.getAttribute('src')) {
          img.removeAttribute('src'); // free decoded image memory for distant slides
        }
      }
    }

    function manageSlides(activeIndex) {
      manageThumbs(activeIndex);
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

    // Mobile-only "swipe up for next" cue — shown on open, auto-hides, and
    // disappears as soon as the user actually swipes.
    function showSwipeHint(total) {
      if (!swipeHint) return;
      clearTimeout(swipeHintTimer);
      const isMobile = window.matchMedia('(max-width: 700px)').matches;
      if (isMobile && total > 1) {
        swipeHint.classList.add('nq-show');
        swipeHint.style.opacity = '1';
        swipeHintTimer = setTimeout(() => { swipeHint.style.opacity = '0'; }, 4500);
      } else {
        swipeHint.classList.remove('nq-show');
      }
    }
    function hideSwipeHint() {
      if (!swipeHint) return;
      clearTimeout(swipeHintTimer);
      swipeHint.style.opacity = '0';
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
          ${v.thumbnailUrl ? `<img class="nq-slide-thumb" data-src="${v.thumbnailUrl}" alt="" decoding="async">` : ''}
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
          hideSwipeHint(); // they're swiping now — drop the hint
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
        showSwipeHint(videos.length); // mobile "swipe up for next" cue
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
      // On a product page, show only videos linked to that product.
      if (!this.applyProductFilter()) return;
      // Layout-aware renderer (all 14 tile types). It builds the right structure
      // for the chosen tile_type and wires memory-safe inline video + click→modal
      // itself, so the old default-only helpers are no longer called here.
      this.renderLayout();
    }

    // On a PDP the block carries data-product-id (the storefront product id).
    // Keep only videos whose stored productId matches it. The picker stores a
    // gid ("gid://shopify/Product/123…") while the PDP gives a number, so we
    // compare just the digits. Returns false (and hides the block) when this
    // product has no videos, so empty carousels never show on product pages.
    applyProductFilter() {
      const pid = (this.container.dataset.productId || '').trim();
      const phandle = (this.container.dataset.productHandle || '').trim().toLowerCase();
      if (!pid && !phandle) return true; // not a product page → show all videos
      const digits = (s) => String(s || '').replace(/\D/g, '');
      const handleOf = (u) => { const m = String(u || '').match(/\/products\/([^/?#]+)/); return m ? m[1].toLowerCase() : ''; };
      const targetId = digits(pid);
      // Match by id OR handle. Stored productId can go stale when products are
      // re-imported/re-created (new Shopify id, same handle) or linked from
      // another store, so the handle is the more reliable key.
      this.videos = this.videos.filter((v) => {
        const idMatch = targetId && digits(v.productId) === targetId;
        const handleMatch = phandle && handleOf(v.productUrl) === phandle;
        return idMatch || handleMatch;
      });
      if (this.videos.length === 0) {
        // Hide the whole section (heading + carousel) when this product has none.
        const section = this.container.closest('.nq-section') || this.container;
        section.style.display = 'none';
        return false;
      }
      return true;
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
        // On a PDP, pass the product context so the API returns only this
        // product's videos (active + deactivated). On home it returns active
        // videos. This keeps deactivated videos out of the home payload.
        const params = new URLSearchParams();
        const pid = (this.container.dataset.productId || '').trim();
        const phandle = (this.container.dataset.productHandle || '').trim();
        if (pid) params.set('product_id', pid);
        if (phandle) params.set('product_handle', phandle);
        const qs = params.toString();
        const res = await fetch(`/apps/nq-videos/api/videos${qs ? '?' + qs : ''}`, {
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

    // Settings come from the block's data-* attributes (see video-carousel.liquid)
    settings() {
      const d = this.container.dataset;
      return {
        tile:      d.tileType || 'product_below_3',
        cardW:     parseInt(d.cardWidth, 10)  || 200,
        cardH:     parseInt(d.cardHeight, 10) || 340,
        shopBtn:   d.shopBtnColor || '#000000',
        autoplay:  d.autoplay !== 'false',
        showViews: d.showViews !== 'false',
      };
    }

    // Field accessors so the layout builders read V2's native video shape.
    vMedia(v)   { return v.streamUrl || v.videoUrl; }
    vIsHls(v)   { return !!v.streamUrl; }
    vThumb(v)   { return v.thumbnailUrl || ''; }
    vTitle(v)   { return v.productTitle || v.title || ''; }
    vImage(v)   { return v.productImageUrl || ''; }
    vViews(v)   { return v.viewCount || 0; }
    vPrice(v)   { return v.price != null ? formatPrice(v.price, v.currency) : ''; }
    vCompare(v) { return v.compareAtPrice != null ? formatPrice(v.compareAtPrice, v.currency) : ''; }
    vDiscount(v){ return (v.compareAtPrice && v.price) ? Math.round((1 - v.price / v.compareAtPrice) * 100) : 0; }

    openAt(idx) {
      if (window._nqOpenModal) window._nqOpenModal(this.videos, idx);
      this.trackEvent('VIEW', this.videos[idx] && this.videos[idx].id);
    }

    // ── Layout dispatcher (all 14 tile types) ──────────────────────────
    renderLayout() {
      const c = this.container, s = this.settings();
      c.classList.add('nq-tile-type-' + s.tile);
      let track = c.querySelector('.nq-carousel-track');
      if (!track) { track = document.createElement('div'); track.className = 'nq-carousel-track'; c.appendChild(track); }
      if (!this.videos.length) { track.innerHTML = '<p class="nq-empty" style="padding:20px">No videos configured yet.</p>'; return; }
      track.innerHTML = '';
      const t = s.tile;
      if (t === 'hero_slide') return this.renderHero(track, s);
      if (t === '3d_navigation') return this.render3D(track, s);
      if (t === 'grid_theme_border' || t === 'grid_no_border' || t === 'feed_on_scroll') return this.renderGrid(track, s);
      return this.renderCarousel(track, s);
    }

    // ── Windowed inline video — memory-safe for large catalogs ─────────
    // Each card shows a lazy <img>; a real <video> is created only while the card
    // is in view and fully destroyed when it scrolls away, so only the handful on
    // screen are ever live (this is what keeps mobile from running out of memory).
    observeCardVideo(card, src, isHls, s) {
      if (!src || !s.autoplay || !('IntersectionObserver' in window)) return;
      let vid = null;
      const io = new IntersectionObserver((entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            if (!vid) {
              vid = document.createElement('video');
              vid.className = 'nq-video-el nq-hover-video';
              vid.muted = true; vid.loop = true; vid.playsInline = true; vid.preload = 'auto';
              vid.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:1;';
              const firstImg = card.querySelector('img');
              card.insertBefore(vid, firstImg ? firstImg.nextSibling : card.firstChild);
              const hls = attachStream(vid, src, isHls, () => {});
              if (hls) cardHlsMap.set(vid, hls);
            }
            vid.play().catch(() => {});
          } else if (vid) {
            const hls = cardHlsMap.get(vid);
            if (hls) { try { hls.destroy(); } catch (x) {} cardHlsMap.delete(vid); }
            try { vid.pause(); vid.removeAttribute('src'); vid.load(); } catch (x) {}
            vid.remove(); vid = null;
          }
        });
      }, { threshold: 0.4, rootMargin: '200px' });
      io.observe(card);
    }

    // Build one .nq-card from a V2 video object — lazy <img> thumbnail, video on demand.
    buildCard(v, i, s) {
      const card = document.createElement('div');
      card.className = 'nq-card nq-tile-' + s.tile;
      const thumb = this.vThumb(v), src = this.vMedia(v), isHls = this.vIsHls(v);
      const img = document.createElement('img');
      img.className = 'nq-video-el';
      img.loading = 'lazy'; img.decoding = 'async';
      img.alt = this.vTitle(v);
      if (thumb) img.src = thumb;
      card.appendChild(img);
      card.onclick = () => this.openAt(i);
      this.observeCardVideo(card, src, isHls, s);
      if (s.showViews) {
        const views = document.createElement('div');
        views.className = 'nq-views';
        views.innerHTML = '&#128065; ' + this.vViews(v);
        card.appendChild(views);
      }
      this.applyTile(card, v, s);
      return card;
    }

    // Per-tile sizing + product overlays (V2 fields).
    applyTile(card, v, s) {
      const cardW = s.cardW, cardH = s.cardH, t = s.tile;
      const img = this.vImage(v), title = this.vTitle(v), price = this.vPrice(v),
            compare = this.vCompare(v), disc = this.vDiscount(v);
      const ovTransparent = () => {
        const ov = document.createElement('div'); ov.className = 'nq-ov-transparent';
        ov.innerHTML = (img ? '<img src="' + img + '" class="nq-ov-thumb">' : '') + '<span class="nq-ov-title">' + title + '</span>';
        card.appendChild(ov);
      };
      switch (t) {
        case 'img_transparent_text_overlay_3':
        case 'img_transparent_text_overlay_2':
        case 'feed_view_more':
          card.style.cssText += 'width:' + cardW + 'px;height:' + cardH + 'px;'; ovTransparent(); break;
        case 'img_opaque_text_overlay_3': {
          card.style.cssText += 'width:' + cardW + 'px;height:' + cardH + 'px;overflow:visible;';
          const ov = document.createElement('div'); ov.className = 'nq-ov-opaque';
          ov.innerHTML = (img ? '<img src="' + img + '" class="nq-ov-thumb">' : '') +
            '<div class="nq-ov-text"><span class="nq-ov-title">' + title + '</span><span class="nq-ov-price">' + price + '</span></div>';
          card.appendChild(ov); break;
        }
        case 'single_tile_no_overlay':
          card.style.cssText += 'width:' + Math.round(cardW * 0.5) + 'px;height:' + Math.round(cardH * 0.65) + 'px;'; break;
        case 'product_below_3':
        case 'product_below_2': {
          card.style.cssText += 'width:' + cardW + 'px;height:' + cardH + 'px;overflow:visible;';
          let dh = '';
          if (compare && disc > 0) dh = '<span class="nq-orig-price">' + compare + '</span><span class="nq-disc-badge">' + disc + '% off</span>';
          const info = document.createElement('div'); info.className = 'nq-below-info';
          info.innerHTML = '<p class="nq-below-title">' + title + '</p><p class="nq-below-price">' + price + ' ' + dh + '</p>';
          card.appendChild(info); break;
        }
        case 'story_format':
          card.style.cssText += 'width:110px;height:110px;border-radius:50%;';
          { const vw = card.querySelector('.nq-views'); if (vw) vw.style.display = 'none'; } break;
        case 'feed_on_scroll': {
          card.classList.add('nq-scroll-fade');
          let pr = price; if (compare && disc > 0) pr += ' <span class="nq-orig-price">' + compare + '</span>';
          const info = document.createElement('div'); info.className = 'nq-below-info';
          info.innerHTML = '<p class="nq-below-title">' + title + '</p><p class="nq-below-price">' + pr + '</p>';
          card.appendChild(info); break;
        }
        case 'grid_theme_border': card.style.border = '3px solid ' + s.shopBtn; break;
        case 'grid_no_border': card.style.borderRadius = '0'; break;
        case '3d_navigation': card.style.cssText += 'width:' + cardW + 'px;height:' + cardH + 'px;'; ovTransparent(); break;
        case 'minimal':
        default: card.style.cssText += 'width:' + cardW + 'px;height:' + cardH + 'px;'; break;
      }
    }

    // ── Horizontal carousel (most card-row tile types) ──
    renderCarousel(track, s) {
      track.className = 'nq-carousel-track nq-carousel';
      this.videos.forEach((v, i) => track.appendChild(this.buildCard(v, i, s)));
      if (s.tile === 'feed_view_more') {
        const wrap = document.createElement('div'); wrap.className = 'nq-view-more-wrap';
        wrap.innerHTML = '<button class="nq-view-more-btn" type="button">VIEW MORE ⌄</button>';
        track.parentNode.appendChild(wrap);
      }
      this.attachScrollArrows(track, s);
    }

    // ── Grid layouts ──
    renderGrid(track, s) {
      track.className = 'nq-carousel-track nq-grid';
      this.videos.forEach((v, i) => track.appendChild(this.buildCard(v, i, s)));
      if (s.tile === 'feed_on_scroll' && 'IntersectionObserver' in window) {
        const io = new IntersectionObserver((entries) => {
          entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('nq-visible'); io.unobserve(e.target); } });
        }, { threshold: 0.12 });
        track.querySelectorAll('.nq-scroll-fade').forEach((c) => io.observe(c));
      }
    }

    // ── 3D coverflow ──
    render3D(track, s) {
      track.className = 'nq-carousel-track';
      const wrap = document.createElement('div'); wrap.className = 'nq-3d-wrap';
      const prev = document.createElement('button'); prev.className = 'nq-3d-prev'; prev.type = 'button'; prev.innerHTML = '❮';
      const next = document.createElement('button'); next.className = 'nq-3d-next'; next.type = 'button'; next.innerHTML = '❯';
      const inner = document.createElement('div'); inner.className = 'nq-3d-track';
      this.videos.forEach((v, i) => inner.appendChild(this.buildCard(v, i, s)));
      wrap.appendChild(prev); wrap.appendChild(inner); wrap.appendChild(next);
      track.appendChild(wrap);
      const cards = inner.querySelectorAll('.nq-card');
      let active = Math.floor(cards.length / 2);
      const cardW = s.cardW;
      const render = () => {
        cards.forEach((card, i) => {
          const diff = i - active, abs = Math.abs(diff);
          card.style.cssText += ';transform:translateX(' + (diff * cardW * 0.68) + 'px) translateZ(' + (abs ? -100 : 0) + 'px) rotateY(' + (diff * -24) + 'deg) scale(' + (abs === 0 ? 1 : abs === 1 ? 0.8 : 0.65) + ');opacity:' + (abs === 0 ? 1 : abs === 1 ? 0.65 : 0.4) + ';z-index:' + (20 - abs) + ';transition:all 0.4s cubic-bezier(.4,0,.2,1)';
        });
      };
      prev.onclick = () => { if (active > 0) { active--; render(); } };
      next.onclick = () => { if (active < cards.length - 1) { active++; render(); } };
      render();
    }

    // ── Hero featured + side strip (desktop) / swipe reel (mobile) ──
    renderHero(track, s) {
      track.className = 'nq-carousel-track';
      const cardH = s.cardH;
      const isMobile = window.innerWidth <= 767;
      const wrap = document.createElement('div'); wrap.className = 'nq-hero-slide-wrap';
      track.appendChild(wrap);
      let heroIndex = 0;
      const setActive = (idx) => {
        heroIndex = idx;
        if (!isMobile) {
          const hv = wrap.querySelector('.nq-hero-video');
          if (hv) { hv.src = this.vMedia(this.videos[idx]); hv.load(); hv.play().catch(() => {}); }
          wrap.querySelectorAll('.nq-side-card').forEach((c) => c.classList.toggle('nq-side-active', +c.dataset.idx === idx));
        }
      };
      if (isMobile) {
        wrap.style.cssText += ';display:flex;flex-direction:row;overflow-x:scroll;scroll-snap-type:x mandatory;gap:10px;scrollbar-width:none;padding-right:28px;';
        this.videos.forEach((v, i) => {
          const card = document.createElement('div'); card.className = 'nq-hero-swipe-card'; card.dataset.idx = i;
          card.style.cssText = 'height:' + Math.round(window.innerHeight * 0.5) + 'px;flex:0 0 92%;width:92%;position:relative;';
          const p = document.createElement('img');
          p.loading = 'lazy'; p.decoding = 'async'; p.setAttribute('data-poster', '1');
          if (this.vThumb(v)) p.src = this.vThumb(v);
          card.appendChild(p);
          card.onclick = () => this.openAt(i);
          wrap.appendChild(card);
        });
        if ('IntersectionObserver' in window) {
          const io = new IntersectionObserver((entries) => {
            entries.forEach((e) => {
              const card = e.target, idx = +card.dataset.idx;
              let vid = card.querySelector('video');
              if (e.isIntersecting) {
                if (!vid) {
                  vid = document.createElement('video');
                  vid.muted = true; vid.loop = true; vid.playsInline = true; vid.preload = 'auto';
                  vid.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:2;';
                  card.appendChild(vid);
                  attachStream(vid, this.vMedia(this.videos[idx]), this.vIsHls(this.videos[idx]), () => {});
                }
                vid.play().catch(() => {});
              } else if (vid) {
                try { vid.pause(); vid.removeAttribute('src'); vid.load(); } catch (x) {}
                vid.remove();
              }
            });
          }, { threshold: 0.6, root: wrap });
          wrap.querySelectorAll('.nq-hero-swipe-card').forEach((c) => io.observe(c));
        }
      } else {
        const main = document.createElement('div'); main.className = 'nq-hero-main'; main.style.height = cardH + 'px';
        const hv = document.createElement('video'); hv.className = 'nq-hero-video'; hv.autoplay = true; hv.muted = true; hv.loop = true; hv.playsInline = true;
        hv.style.cssText = 'width:100%;height:' + cardH + 'px;object-fit:cover;display:block;';
        main.appendChild(hv); main.onclick = () => this.openAt(heroIndex);
        const stripOuter = document.createElement('div'); stripOuter.className = 'nq-hero-strip-outer'; stripOuter.style.height = cardH + 'px';
        const strip = document.createElement('div'); strip.className = 'nq-hero-slide-strip'; strip.style.cssText = 'height:' + cardH + 'px;max-height:' + cardH + 'px;';
        const sideH = Math.round((cardH - 16) / 3);
        this.videos.forEach((v, i) => {
          const card = document.createElement('div'); card.className = 'nq-side-card' + (i === 0 ? ' nq-side-active' : ''); card.dataset.idx = i;
          card.style.cssText = 'height:' + sideH + 'px;position:relative;';
          card.innerHTML = '<div class="nq-side-ring"></div>' + (this.vThumb(v) ? '<img src="' + this.vThumb(v) + '" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;">' : '');
          const views = document.createElement('div'); views.className = 'nq-views'; views.innerHTML = '&#128065; ' + this.vViews(v); card.appendChild(views);
          card.addEventListener('click', () => setActive(i));
          strip.appendChild(card);
        });
        stripOuter.appendChild(strip);
        wrap.appendChild(main); wrap.appendChild(stripOuter);
        setActive(0);
      }
    }

    // Reusable prev/next scroll arrows for the horizontal carousel.
    attachScrollArrows(track, s) {
      const mk = (cls, glyph) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'nq-scroll-btn ' + cls; b.innerHTML = glyph; return b; };
      const prev = mk('nq-scroll-prev', '❮'), next = mk('nq-scroll-next', '❯');
      track.parentNode.style.position = 'relative';
      track.parentNode.appendChild(prev); track.parentNode.appendChild(next);
      const amt = () => (s.cardW + 12);
      prev.onclick = () => track.scrollBy({ left: -amt(), behavior: 'smooth' });
      next.onclick = () => track.scrollBy({ left: amt(), behavior: 'smooth' });
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
