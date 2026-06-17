/**
 * NQ Shoppable Videos
 * Carousel with inline HLS autoplay + fullscreen modal + add-to-cart
 */

(function () {
  'use strict';

  // ─── Modal singleton state ──────────────────────────────────────────
  let modalVideos = [];
  let modalIndex = 0;
  let modalHls = null;
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

  // ─── Modal ──────────────────────────────────────────────────────────
  function initModal() {
    if (modalInitialized) return;
    modalInitialized = true;

    const modal     = document.getElementById('nq-modal');
    const bg        = document.getElementById('nq-modal-bg');
    const videoEl   = document.getElementById('nq-video');
    const closeBtn  = document.getElementById('nq-close-btn');
    const peekPrev    = document.getElementById('nq-peek-prev');
    const peekNext    = document.getElementById('nq-peek-next');
    const peekPrevImg = document.getElementById('nq-peek-prev-img');
    const peekNextImg = document.getElementById('nq-peek-next-img');
    const arrowPrev   = document.getElementById('nq-arrow-prev');
    const arrowNext   = document.getElementById('nq-arrow-next');
    const prevBtn     = document.getElementById('nq-prev-btn');
    const nextBtn     = document.getElementById('nq-next-btn');
    const counter     = document.getElementById('nq-counter');
    const muteBtn     = document.getElementById('nq-mute-btn');
    const iconSound = document.getElementById('nq-icon-sound');
    const iconMuted = document.getElementById('nq-icon-muted');

    if (!modal) return;

    // ── Loading overlay ──────────────────────────────────────────────
    const videoPanel = modal.querySelector('.nq-modal-video-panel');
    if (videoPanel) {
      const loadingOverlay = document.createElement('div');
      loadingOverlay.className = 'nq-video-loading';
      loadingOverlay.innerHTML = '<div class="nq-spinner"></div>';
      videoPanel.appendChild(loadingOverlay);
    }

    // ── Hidden elements for preloading up to 2 videos ahead ─────────
    const preloadEls = [0, 1, 2].map(() => {
      const el = document.createElement('video');
      el.muted = true;
      el.style.cssText = 'display:none;position:absolute;pointer-events:none;';
      document.body.appendChild(el);
      return el;
    });
    // slots: 0 = next, 1 = next+1, 2 = prev
    let preloadHls = [null, null, null];

    function preloadAt(v, slotIndex) {
      if (preloadHls[slotIndex]) { preloadHls[slotIndex].destroy(); preloadHls[slotIndex] = null; }
      const el = preloadEls[slotIndex];
      el.src = '';
      if (!v) return;
      const src   = v.streamUrl || v.videoUrl;
      const isHls = !!(v.streamUrl);
      preloadHls[slotIndex] = attachStream(el, src, isHls, () => { el.pause(); });
    }

    function openModal(videos, index) {
      modalVideos = videos;
      modalIndex  = index;
      modal.style.display = 'flex';
      document.body.style.overflow = 'hidden';
      document.body.classList.add('nq-modal-open');
      renderModalVideo();
    }

    function closeModal() {
      modal.style.display = 'none';
      document.body.style.overflow = '';
      document.body.classList.remove('nq-modal-open');
      videoEl.pause();
      videoEl.src = '';
      if (modalHls) { modalHls.destroy(); modalHls = null; }
      // Clean up all preload instances
      preloadHls.forEach((hls, i) => { if (hls) { hls.destroy(); preloadHls[i] = null; } });
      preloadEls.forEach((el) => { el.src = ''; });
    }

    function renderModalVideo() {
      const v = modalVideos[modalIndex];
      if (!v) return;

      // Show loading spinner
      const vPanel = modal.querySelector('.nq-modal-video-panel');
      if (vPanel) vPanel.classList.add('nq-loading');

      // Hide spinner once video is actually playing
      const hideLoading = () => {
        if (vPanel) vPanel.classList.remove('nq-loading');
        videoEl.removeEventListener('playing', hideLoading);
      };
      videoEl.addEventListener('playing', hideLoading);

      // Stop previous
      videoEl.pause();
      videoEl.src = '';
      if (modalHls) { modalHls.destroy(); modalHls = null; }

      videoEl.muted = true;
      iconMuted.style.display = 'block';
      iconSound.style.display = 'none';

      // Prefer HLS stream, fall back to MP4
      const src   = v.streamUrl || v.videoUrl;
      const isHls = !!(v.streamUrl);

      modalHls = attachStream(videoEl, src, isHls, () => {
        videoEl.play().catch(() => {});
      });

      // Preload N+1 immediately — user most likely swipes forward
      preloadAt(modalVideos[modalIndex + 1], 0);
      // Preload N+2 and prev after a short delay so current gets bandwidth first
      setTimeout(() => {
        preloadAt(modalVideos[modalIndex + 2], 1);
        preloadAt(modalVideos[modalIndex - 1], 2);
      }, 600);

      // Counter
      if (counter) counter.textContent = (modalIndex + 1) + ' / ' + modalVideos.length;

      // Peek prev + desktop arrow
      const prevV = modalVideos[modalIndex - 1];
      if (peekPrev) peekPrev.dataset.hidden = prevV ? 'false' : 'true';
      if (peekPrevImg && prevV) { peekPrevImg.src = prevV.thumbnailUrl || ''; peekPrevImg.alt = prevV.productTitle || ''; }
      if (arrowPrev) arrowPrev.dataset.hidden = prevV ? 'false' : 'true';

      // Peek next + desktop arrow
      const nextV = modalVideos[modalIndex + 1];
      if (peekNext) peekNext.dataset.hidden = nextV ? 'false' : 'true';
      if (peekNextImg && nextV) { peekNextImg.src = nextV.thumbnailUrl || ''; peekNextImg.alt = nextV.productTitle || ''; }
      if (arrowNext) arrowNext.dataset.hidden = nextV ? 'false' : 'true';

      // Product panel
      const card = document.getElementById('nq-product-card');
      if (!card) return;

      const discount = v.compareAtPrice && v.price
        ? Math.round((1 - v.price / v.compareAtPrice) * 100)
        : null;

      card.innerHTML = `
        <div class="nq-product-inner">

          <!-- Mobile compact bar (shown on mobile, hidden on desktop) -->
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

          <!-- Desktop full layout -->
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

      // Update mobile cart button href
      const mobileCartBtn = document.getElementById('nq-mobile-cart');
      if (mobileCartBtn) {
        if (v.variantId) {
          mobileCartBtn.href = `/cart/${v.variantId}:1?checkout`;
          mobileCartBtn.style.display = 'flex';
        } else {
          mobileCartBtn.style.display = 'none';
        }
      }
    }

    // ── Event listeners ──────────────────────────────────────────────
    bg.addEventListener('click', closeModal);
    closeBtn.addEventListener('click', closeModal);

    if (peekPrev) peekPrev.addEventListener('click', () => {
      if (modalIndex > 0) { modalIndex--; renderModalVideo(); }
    });

    if (peekNext) peekNext.addEventListener('click', () => {
      if (modalIndex < modalVideos.length - 1) { modalIndex++; renderModalVideo(); }
    });

    // Mobile nav arrows
    if (prevBtn) prevBtn.addEventListener('click', () => {
      if (modalIndex > 0) { modalIndex--; renderModalVideo(); }
    });

    if (nextBtn) nextBtn.addEventListener('click', () => {
      if (modalIndex < modalVideos.length - 1) { modalIndex++; renderModalVideo(); }
    });

    // Desktop far-edge arrows
    if (arrowPrev) arrowPrev.addEventListener('click', () => {
      if (modalIndex > 0) { modalIndex--; renderModalVideo(); }
    });

    if (arrowNext) arrowNext.addEventListener('click', () => {
      if (modalIndex < modalVideos.length - 1) { modalIndex++; renderModalVideo(); }
    });

    muteBtn.addEventListener('click', () => {
      videoEl.muted = !videoEl.muted;
      iconMuted.style.display = videoEl.muted ? 'block' : 'none';
      iconSound.style.display = videoEl.muted ? 'none' : 'block';
    });

    document.addEventListener('keydown', (e) => {
      if (modal.style.display === 'none') return;
      if (e.key === 'Escape')      closeModal();
      if (e.key === 'ArrowLeft'  && modalIndex > 0)                      { modalIndex--; renderModalVideo(); }
      if (e.key === 'ArrowRight' && modalIndex < modalVideos.length - 1) { modalIndex++; renderModalVideo(); }
    });

    let touchStartX = 0, touchStartY = 0;
    const modalLayout = modal.querySelector('.nq-modal-layout');
    if (modalLayout) {
      modalLayout.addEventListener('touchstart', (e) => {
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
      }, { passive: true });
      modalLayout.addEventListener('touchend', (e) => {
        const diffX = touchStartX - e.changedTouches[0].clientX;
        const diffY = touchStartY - e.changedTouches[0].clientY;
        // Prefer vertical swipe on mobile (up = next, down = prev)
        if (Math.abs(diffY) > Math.abs(diffX) && Math.abs(diffY) > 50) {
          if (diffY > 0 && modalIndex < modalVideos.length - 1) { modalIndex++; renderModalVideo(); }
          if (diffY < 0 && modalIndex > 0)                      { modalIndex--; renderModalVideo(); }
        } else if (Math.abs(diffX) > 40) {
          if (diffX > 0 && modalIndex < modalVideos.length - 1) { modalIndex++; renderModalVideo(); }
          if (diffX < 0 && modalIndex > 0)                      { modalIndex--; renderModalVideo(); }
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
      // Attach stream immediately — fetches manifest + first segment into browser cache
      const hls = attachStream(videoEl, src, isHls, () => { videoEl.pause(); });
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

            // Attach stream but don't play yet — just pre-fetch manifest + first segment
            const hls = attachStream(videoEl, src, isHls, () => {
              // onReady: pause immediately, play observer will call play() when centered
              videoEl.pause();
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
            videoEl.play()
              .then(() => {
                videoEl.classList.add('nq-playing');
                if (thumb) thumb.classList.add('nq-hidden');
              })
              .catch(() => {});
          } else {
            videoEl.pause();
            videoEl.classList.remove('nq-playing');
            if (thumb) thumb.classList.remove('nq-hidden');
          }
        });
      }, { root: track, threshold: 0.65 });

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
