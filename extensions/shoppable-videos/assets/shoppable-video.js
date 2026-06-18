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
    const swiperWrapper = document.getElementById('nq-swiper-wrapper');

    if (!modal || !swiperWrapper) return;

    let swiperInstance = null;
    let slideHlsMap    = {};   // slide index → HLS instance
    let isMuted        = true;
    // Only keep the active slide + immediate neighbours loaded. A wider window
    // oversubscribes the browser's limited connections to the R2 host (which
    // isn't HTTP/2-multiplexed like Shopify's CDN), causing every <video> to
    // deadlock at readyState 0 after an open/close cycle. 1 = active + next +
    // prev, which still keeps the next video instant without the deadlock.
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
      const videoEl = slide.querySelector('.nq-slide-video');
      if (videoEl) videoEl.classList.remove('nq-playing');
      const thumb = slide.querySelector('.nq-slide-thumb');
      if (thumb) thumb.classList.remove('nq-slide-thumb-hidden');
    }

    // Play the active slide and reveal it the instant it has a real frame.
    function playSlide(index) {
      const videoEl = getSlideVideo(index);
      if (!videoEl) return;
      const slide = swiperWrapper.children[index];
      videoEl.muted = isMuted;

      const onFrame = () => {
        if (swiperInstance && swiperInstance.activeIndex === index) revealSlide(index);
      };

      if (videoEl.readyState >= 2) {
        // Already has a decoded frame — reveal immediately, no spinner.
        videoEl.play().catch(() => {});
        onFrame();
      } else {
        // Still buffering — keep the thumbnail up (with spinner) until the
        // first frame is painted, then crossfade to video.
        if (slide) slide.classList.add('nq-loading');
        videoEl.addEventListener('playing', onFrame, { once: true });
        videoEl.addEventListener('loadeddata', onFrame, { once: true });
        videoEl.play().catch(() => {});
      }
    }

    function initSlideHls(index) {
      if (slideHlsMap[index] !== undefined) return; // already init'd (or null for MP4)
      const v = modalVideos[index];
      if (!v) return;
      const videoEl = getSlideVideo(index);
      if (!videoEl) return;

      const src   = v.streamUrl || v.videoUrl;
      const isHls  = !!(v.streamUrl);

      // Buffer eagerly — small files, so this is cheap and makes swipes instant.
      videoEl.preload = 'auto';

      const hls = attachStream(videoEl, src, isHls, () => {
        // Source attached/ready — only auto-play if this is the active slide.
        if (swiperInstance && swiperInstance.activeIndex === index) playSlide(index);
      });
      slideHlsMap[index] = hls || null;
    }

    function destroySlideHls(index) {
      const hls = slideHlsMap[index];
      if (hls) { hls.destroy(); }
      delete slideHlsMap[index];
      const videoEl = getSlideVideo(index);
      if (videoEl) {
        videoEl.pause();
        videoEl.removeAttribute('src');
        try { videoEl.load(); } catch {}
      }
      resetSlide(index); // back to thumbnail so a later revisit isn't black
    }

    function manageSlides(activeIndex) {
      const total = modalVideos.length;
      const keepAlive = new Set();
      for (let i = Math.max(0, activeIndex - PRELOAD_RANGE); i <= Math.min(total - 1, activeIndex + PRELOAD_RANGE); i++) {
        keepAlive.add(i);
      }
      // Free slides outside the window (and reset them to thumbnail state)
      Object.keys(slideHlsMap).forEach((idx) => {
        if (!keepAlive.has(Number(idx))) destroySlideHls(Number(idx));
      });
      // Buffer everything inside the window — neighbours download while you watch
      keepAlive.forEach((idx) => initSlideHls(idx));

      // Play active, pause + show-thumbnail for the rest
      for (let i = 0; i < total; i++) {
        const videoEl = getSlideVideo(i);
        if (!videoEl) continue;
        if (i === activeIndex) {
          playSlide(i);
        } else {
          videoEl.pause();
          resetSlide(i);
        }
      }
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

      const discount = v.compareAtPrice && v.price
        ? Math.round((1 - v.price / v.compareAtPrice) * 100)
        : null;

      card.innerHTML = `
        <div class="nq-product-inner">
          <div class="nq-mobile-bar">
            ${v.productImageUrl ? `<img class="nq-mobile-thumb" src="${v.productImageUrl}" alt="${v.productTitle || ''}" loading="lazy">` : ''}
            <div class="nq-mobile-info">
              <p class="nq-product-name" style="font-size:13px;margin:0 0 3px;">${v.productTitle || 'View Product'}</p>
              <div class="nq-product-prices">
                ${v.price ? `<p class="nq-product-price" style="font-size:13px;">${formatPrice(v.price, v.currency)}</p>` : ''}
                ${v.compareAtPrice ? `<p class="nq-product-compare" style="font-size:12px;">${formatPrice(v.compareAtPrice, v.currency)}</p>` : ''}
              </div>
            </div>
            ${v.productUrl ? `<a class="nq-mobile-shop" href="${v.productUrl}">Shop Now</a>` : ''}
          </div>
          ${v.productImageUrl
            ? `<img class="nq-product-img-full" src="${v.productImageUrl}" alt="${v.productTitle || ''}" loading="lazy">`
            : '<div class="nq-product-img-placeholder"></div>'}
          <div class="nq-product-details">
            <p class="nq-product-name">${v.productTitle || 'View Product'}</p>
            <div class="nq-product-prices">
              ${v.price ? `<p class="nq-product-price">${formatPrice(v.price, v.currency)}</p>` : ''}
              ${v.compareAtPrice ? `<p class="nq-product-compare">${formatPrice(v.compareAtPrice, v.currency)}</p>` : ''}
              ${discount ? `<span class="nq-product-badge">${discount}% off</span>` : ''}
            </div>
            <hr class="nq-divider" />
          </div>
          <div class="nq-actions">
            ${v.productUrl ? `<a class="nq-btn nq-btn-info" href="${v.productUrl}">More info</a>` : ''}
            ${v.variantId ? `
              <button class="nq-btn nq-btn-atc" data-variant="${v.variantId}" data-video-id="${v.id}" onclick="NQShoppable.addToCart(this)">Add to cart</button>
              <a class="nq-btn nq-btn-cart" href="/cart/${v.variantId}:1?checkout" title="Checkout">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/>
                  <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/>
                </svg>
              </a>
            ` : ''}
          </div>
        </div>
      `;

      const mobileCartBtn = document.getElementById('nq-mobile-cart');
      if (mobileCartBtn) {
        mobileCartBtn.href         = v.variantId ? `/cart/${v.variantId}:1?checkout` : '#';
        mobileCartBtn.style.display = v.variantId ? 'flex' : 'none';
      }
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

      // Build one slide per video.
      // IMPORTANT: poster attribute is destroyed by HLS.js on attachMedia — do NOT rely on it.
      // Instead, use a separate <img> overlay (same pattern as carousel cards) that fades out on play.
      // Slides start in their thumbnail state (no nq-loading). The spinner is
      // only added by playSlide() while the ACTIVE video is still buffering,
      // so idle/neighbour slides simply show their thumbnail.
      swiperWrapper.innerHTML = videos.map((v) => `
        <div class="swiper-slide nq-video-slide">
          <video class="nq-slide-video" playsinline webkit-playsinline muted loop preload="none"></video>
          ${v.thumbnailUrl ? `<img class="nq-slide-thumb" src="${v.thumbnailUrl}" alt="">` : ''}
          <div class="nq-video-loading"><div class="nq-spinner"></div></div>
        </div>
      `).join('');

      // Init Swiper (loads from CDN on first open)
      loadSwiper().then((Swiper) => {
        if (!Swiper) return;
        swiperInstance = new Swiper('#nq-video-swiper', {
          direction: getModalDirection(),
          speed: 280,
          initialSlide: index,
          grabCursor: true,
          resistanceRatio: 0.6,
          on: {
            // Fire during the swipe animation — start buffering the incoming video immediately
            slideChangeTransitionStart: () => {
              modalIndex = swiperInstance.activeIndex;
              manageSlides(modalIndex);
            },
            // Fire after animation completes — update UI once the slide is settled
            slideChange: () => {
              updateUI(modalIndex);
              iconMuted.style.display = isMuted ? 'block' : 'none';
              iconSound.style.display  = isMuted ? 'none'  : 'block';
            },
          },
        });
        updateUI(index);
        manageSlides(index);
      });
    }

    function closeModal() {
      modal.style.display = 'none';
      document.body.style.overflow = '';
      document.body.classList.remove('nq-modal-open');
      Object.keys(slideHlsMap).forEach((idx) => destroySlideHls(Number(idx)));
      slideHlsMap = {};
      if (swiperInstance) { swiperInstance.destroy(true, true); swiperInstance = null; }
      swiperWrapper.innerHTML = '';

      // Resume the carousel now that the modal's videos are gone.
      resumeCarouselVideos();
    }

    // ── Event listeners ──────────────────────────────────────────────────
    bg.addEventListener('click', closeModal);
    closeBtn.addEventListener('click', closeModal);

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
      this.preloadFirstCard();
      this.setupIntersectionObserver();
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
                ${v.price ? `<p class="nq-card-price">${formatPrice(v.price, v.currency)}</p>` : ''}
                ${v.compareAtPrice ? `<p class="nq-card-compare-price">${formatPrice(v.compareAtPrice, v.currency)}</p>` : ''}
                ${discount ? `<p class="nq-card-discount">${discount}% off</p>` : ''}
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
