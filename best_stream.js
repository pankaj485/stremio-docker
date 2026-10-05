// Injected into stremio-web as an extra webpack entry (see Dockerfile).
// Ranks the torrent streams listed on a details page by how likely they are to
// play smoothly, marks the top one and adds a "Play best stream" button.
//
// stremio-web renders each stream as <a class="stream-container-<hash>"> inside
// <div class="streams-container-<hash>">; only those class-name prefixes are
// relied on. Nothing is inserted into React-managed DOM: the badge is a CSS
// pseudo-element keyed on a data attribute and the button lives on <body>.

const LIST_SELECTOR = '[class*="streams-container-"]';
const STREAM_SELECTOR = 'a[class*="stream-container-"]';
const BEST_ATTR = 'data-best-stream';
const BUTTON_ID = 'best-stream-button';

// Seeds needed per GB before a swarm counts as fully healthy. Bigger files need
// a higher bitrate, so they need proportionally more sources to keep up.
const SEEDS_PER_GB = 30;
// Leechers hold partial copies and upload too, but are worth less than a seed.
const PEER_WEIGHT = 0.25;
// 2160p ranks below 1080p: it needs about twice the download rate and browsers
// handle 4K HDR poorly.
const RESOLUTION_BONUS = { 2160: 10, 1080: 15, 720: 8 };

function parseStream(text) {
    const seeds = text.match(/👤\s*(\d+)/u) || text.match(/\bseed(?:er)?s?\s*[:=]?\s*(\d+)/i) || text.match(/(\d+)\s*seed/i);
    if (!seeds) return null;

    const peers = text.match(/👥\s*(\d+)/u) || text.match(/\b(?:peer|leech(?:er)?)s?\s*[:=]?\s*(\d+)/i) || text.match(/(\d+)\s*(?:peer|leech)/i);
    const size = text.match(/([\d.]+)\s*(TB|GB|MB)\b/i);
    const unit = size ? { TB: 1024, GB: 1, MB: 1 / 1024 }[size[2].toUpperCase()] : 0;

    let resolution = 0;
    if (/\b(2160p|4k|uhd)\b/i.test(text)) resolution = 2160;
    else if (/\b1080p\b/i.test(text)) resolution = 1080;
    else if (/\b720p\b/i.test(text)) resolution = 720;
    else if (/\b480p\b/i.test(text)) resolution = 480;

    return {
        seeds: Number(seeds[1]),
        peers: peers ? Number(peers[1]) : 0,
        sizeGB: size ? Number(size[1]) * unit : 0,
        resolution,
    };
}

function scoreStream({ seeds, peers, sizeGB, resolution }) {
    const sources = seeds + PEER_WEIGHT * peers;
    // Unknown size is treated as a typical 1080p file.
    const needed = SEEDS_PER_GB * Math.max(sizeGB || 4, 1);
    const health = Math.min(1, Math.log1p(sources) / Math.log1p(needed));
    return 100 * health + (RESOLUTION_BONUS[resolution] || 0);
}

function describe({ seeds, peers, sizeGB, resolution }) {
    return [
        resolution ? `${resolution}p` : null,
        `${seeds} seeds`,
        peers ? `${peers} peers` : null,
        sizeGB ? `${sizeGB >= 1 ? sizeGB.toFixed(1) + ' GB' : Math.round(sizeGB * 1024) + ' MB'}` : null,
    ].filter(Boolean).join(' · ');
}

function findBest() {
    const list = [...document.querySelectorAll(LIST_SELECTOR)].find((el) => el.getClientRects().length > 0);
    if (!list) return null;

    let best = null;
    for (const element of list.querySelectorAll(STREAM_SELECTOR)) {
        const info = parseStream(element.innerText || '');
        if (!info) continue;
        const score = scoreStream(info);
        if (!best || score > best.score) best = { element, info, score, list };
    }
    return best;
}

function ensureStyles() {
    if (document.getElementById('best-stream-styles')) return;
    const style = document.createElement('style');
    style.id = 'best-stream-styles';
    style.textContent = `
        ${STREAM_SELECTOR}[${BEST_ATTR}] { position: relative; outline: 2px solid var(--primary-accent-color, #7b5bf5); outline-offset: -2px; }
        ${STREAM_SELECTOR}[${BEST_ATTR}]::after {
            content: '★ Best'; position: absolute; top: 0; right: 0; padding: 0.15rem 0.6rem;
            font-size: 0.8rem; font-weight: 600; color: #fff;
            background: var(--primary-accent-color, #7b5bf5); border-radius: 0 0 0 0.5rem;
        }
        ${LIST_SELECTOR} { padding-bottom: 5rem !important; }
        #${BUTTON_ID} {
            position: fixed; z-index: 10; display: none; box-sizing: border-box; height: 3.5rem; padding: 0 1rem;
            border: 0; border-radius: 2rem; cursor: pointer; font: inherit; font-weight: 600; color: #fff;
            background: var(--primary-accent-color, #7b5bf5); box-shadow: 0 0.25rem 1rem rgba(0, 0, 0, 0.5);
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        #${BUTTON_ID} small { font-weight: 400; opacity: 0.85; margin-left: 0.5rem; }
    `;
    document.head.appendChild(style);
}

function ensureButton() {
    let button = document.getElementById(BUTTON_ID);
    if (!button) {
        button = document.createElement('button');
        button.id = BUTTON_ID;
        button.type = 'button';
        // Clicking the stream's own link keeps stremio-web's click handling.
        button.addEventListener('click', () => {
            const target = document.querySelector(`${STREAM_SELECTOR}[${BEST_ATTR}]`);
            if (target) target.click();
        });
        document.body.appendChild(button);
    }
    return button;
}

function update() {
    ensureStyles();
    const button = ensureButton();
    const best = findBest();

    for (const element of document.querySelectorAll(`[${BEST_ATTR}]`)) {
        if (!best || element !== best.element) element.removeAttribute(BEST_ATTR);
    }

    if (!best) {
        button.style.display = 'none';
        return;
    }

    if (!best.element.hasAttribute(BEST_ATTR)) best.element.setAttribute(BEST_ATTR, '');

    const summary = describe(best.info);
    const label = `▶ Play best stream<small>${summary}</small>`;
    if (button.innerHTML !== label) button.innerHTML = label;
    button.title = `Best pick by seeds, peers, size and resolution: ${summary}`;

    const rect = best.list.getBoundingClientRect();
    button.style.left = `${rect.left + 16}px`;
    button.style.width = `${Math.max(rect.width - 32, 0)}px`;
    button.style.top = `${Math.min(rect.bottom, window.innerHeight) - 72}px`;
    button.style.display = 'block';
}

let scheduled = false;
function scheduleUpdate() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
        scheduled = false;
        try {
            update();
        } catch (error) {
            console.error('[web] best stream:', error);
        }
    }, 200);
}

function start() {
    new MutationObserver(scheduleUpdate).observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', scheduleUpdate);
    window.addEventListener('hashchange', scheduleUpdate);
    scheduleUpdate();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
} else {
    start();
}
