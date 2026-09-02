/*
 * Emote and GIF catalogue.
 *
 * Twitch pulls these from its own CDN plus BTTV/7TV, and its GIF tab is Tenor.
 * This client has to work with nothing but the Worker in front of it, so the
 * catalogue is local: emotes are Unicode glyphs given Twitch-style codes, and
 * the "GIFs" are animated SVG stickers authored here.
 *
 * Everything the rest of the app needs goes through `EMOTE_SETS`, `GIF_SET` and
 * `lookupEmote`, so swapping in a real provider is one module, not a rewrite.
 */

/** Inline emote size, matching Twitch's 28px chat emotes. */
export const EMOTE_PX = 28;

const set = (id, label, icon, codes) => ({ id, label, icon, emotes: codes });
const e = (code, glyph) => ({ code, glyph });

/**
 * The "channel" set: the codes people actually type in a live chat. Ordered by
 * how often they get used, not alphabetically — the picker is a hand, not a
 * dictionary.
 */
const CHANNEL = [
  e("pog", "😮"), e("lul", "😂"), e("kekw", "🤣"), e("based", "😎"),
  e("sadge", "😔"), e("copium", "😤"), e("hype", "🔥"), e("clap", "👏"),
  e("gg", "🤝"), e("goat", "🐐"), e("rocket", "🚀"), e("skull", "💀"),
  e("eyes", "👀"), e("think", "🤔"), e("rage", "😡"), e("cry", "😭"),
  e("love", "❤️"), e("party", "🎉"), e("wave", "👋"), e("ok", "👌"),
  e("no", "🙅"), e("pray", "🙏"), e("muscle", "💪"), e("brain", "🧠"),
  e("money", "🤑"), e("cold", "🥶"), e("hot", "🥵"), e("sleep", "😴"),
];

const SMILEYS = [
  e("grin", "😀"), e("smile", "😄"), e("joy", "😂"), e("rofl", "🤣"),
  e("blush", "😊"), e("wink", "😉"), e("heart_eyes", "😍"), e("kiss", "😘"),
  e("tongue", "😜"), e("cool", "😎"), e("nerd", "🤓"), e("monocle", "🧐"),
  e("neutral", "😐"), e("smirk", "😏"), e("unamused", "😒"), e("sweat", "😅"),
  e("weary", "😩"), e("sob", "😭"), e("angry", "😠"), e("rage2", "🤬"),
  e("shock", "😱"), e("mind_blown", "🤯"), e("shush", "🤫"), e("zip", "🤐"),
  e("clown", "🤡"), e("ghost", "👻"), e("alien", "👽"), e("robot", "🤖"),
];

const GESTURES = [
  e("thumbsup", "👍"), e("thumbsdown", "👎"), e("fist", "✊"), e("punch", "👊"),
  e("wave2", "👋"), e("raised", "🙌"), e("handshake", "🤝"), e("point", "👉"),
  e("victory", "✌️"), e("horns", "🤘"), e("call", "🤙"), e("pinch", "🤏"),
  e("salute", "🫡"), e("heart_hands", "🫶"), e("facepalm", "🤦"), e("shrug", "🤷"),
];

const THINGS = [
  e("fire", "🔥"), e("star", "⭐"), e("sparkles", "✨"), e("boom", "💥"),
  e("zap", "⚡"), e("trophy", "🏆"), e("medal", "🥇"), e("crown", "👑"),
  e("gift", "🎁"), e("cake", "🎂"), e("pizza", "🍕"), e("coffee", "☕"),
  e("beer", "🍺"), e("popcorn", "🍿"), e("game", "🎮"), e("dice", "🎲"),
  e("ball", "⚽"), e("music", "🎵"), e("camera", "📸"), e("bell", "🔔"),
];

const HEARTS = [
  e("red_heart", "❤️"), e("purple_heart", "💜"), e("blue_heart", "💙"),
  e("green_heart", "💚"), e("yellow_heart", "💛"), e("orange_heart", "🧡"),
  e("black_heart", "🖤"), e("white_heart", "🤍"), e("broken", "💔"),
  e("sparkle_heart", "💖"), e("two_hearts", "💕"), e("heartbeat", "💓"),
];

export const EMOTE_SETS = [
  set("channel", "live-chat", "🟣", CHANNEL),
  set("smileys", "Rostos", "😀", SMILEYS),
  set("gestures", "Gestos", "👋", GESTURES),
  set("things", "Coisas", "🔥", THINGS),
  set("hearts", "Corações", "❤️", HEARTS),
];

/** code -> glyph, for `:code:` autocompletion in the composer. */
const BY_CODE = new Map();
for (const group of EMOTE_SETS) {
  for (const emote of group.emotes) if (!BY_CODE.has(emote.code)) BY_CODE.set(emote.code, emote);
}

export function lookupEmote(code) {
  return BY_CODE.get(code.toLowerCase()) ?? null;
}

export function searchEmotes(query) {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const hits = [];
  for (const emote of BY_CODE.values()) {
    if (emote.code.includes(q)) hits.push(emote);
    if (hits.length >= 60) break;
  }
  return hits;
}

/* ------------------------------------------------------------------ */
/* GIF stickers                                                        */
/* ------------------------------------------------------------------ */

/**
 * A sticker is sent as the token `[gif:id]` inside the message body, so every
 * client renders the same thing without the protocol having to carry media.
 * An unknown id stays visible as plain text rather than disappearing.
 *
 * The animations are declared inside each SVG and stop under
 * `prefers-reduced-motion`, which the stylesheet enforces for the whole app.
 */
const FONT = 'font-family="Inter, Segoe UI, Helvetica, Arial, sans-serif"';

const sticker = (id, label, body) => ({
  id,
  label,
  svg: `<svg viewBox="0 0 120 90" role="img" aria-label="${label}" xmlns="http://www.w3.org/2000/svg">${body}</svg>`,
});

export const GIF_SET = [
  sticker(
    "party",
    "Festa",
    `<style>
      .cf{animation:fall 1.5s linear infinite}
      .cf:nth-of-type(2){animation-delay:.25s}.cf:nth-of-type(3){animation-delay:.5s}
      .cf:nth-of-type(4){animation-delay:.75s}.cf:nth-of-type(5){animation-delay:1s}
      @keyframes fall{0%{transform:translateY(-20px) rotate(0)}100%{transform:translateY(96px) rotate(240deg)}}
     </style>
     <rect width="120" height="90" rx="8" fill="#2a1d47"/>
     <text x="60" y="55" font-size="19" font-weight="800" fill="#e9defd" ${FONT}
       text-anchor="middle" letter-spacing="1">FESTA</text>
     <rect class="cf" x="14" y="0" width="7" height="11" rx="1.5" fill="#9147ff"/>
     <rect class="cf" x="40" y="0" width="7" height="11" rx="1.5" fill="#00c8af"/>
     <rect class="cf" x="66" y="0" width="7" height="11" rx="1.5" fill="#ffd400"/>
     <rect class="cf" x="92" y="0" width="7" height="11" rx="1.5" fill="#ff4b7d"/>
     <rect class="cf" x="104" y="0" width="7" height="11" rx="1.5" fill="#5bcefa"/>`,
  ),
  sticker(
    "hype",
    "Hype",
    `<style>.fl{transform-origin:60px 58px;animation:pulse .62s ease-in-out infinite alternate}
      @keyframes pulse{from{transform:scale(.85)}to{transform:scale(1.1)}}</style>
     <rect width="120" height="90" rx="8" fill="#3a1d12"/>
     <g class="fl">
       <path d="M60 20c9 11 15 18 15 27a15 15 0 0 1-30 0c0-6 4-10 7-15 2 4 4 6 6 6 2-6-2-11 2-18Z" fill="#ff7a18"/>
       <path d="M60 40c4 6 7 9 7 14a7 7 0 0 1-14 0c0-4 3-7 7-14Z" fill="#ffd400"/>
     </g>`,
  ),
  sticker(
    "clap",
    "Palmas",
    `<style>
      .l{transform-origin:60px 50px;animation:lh .42s ease-in-out infinite alternate}
      .r{transform-origin:60px 50px;animation:rh .42s ease-in-out infinite alternate}
      .sp{animation:sp .42s ease-in-out infinite alternate}
      @keyframes lh{from{transform:translateX(-11px) rotate(-8deg)}to{transform:translateX(-1px) rotate(0)}}
      @keyframes rh{from{transform:translateX(11px) rotate(8deg)}to{transform:translateX(1px) rotate(0)}}
      @keyframes sp{from{opacity:0}to{opacity:.9}}
     </style>
     <rect width="120" height="90" rx="8" fill="#1e2f3a"/>
     <rect class="l" x="38" y="32" width="20" height="34" rx="9" fill="#ffd9b0"/>
     <rect class="r" x="62" y="32" width="20" height="34" rx="9" fill="#ffc99a"/>
     <g class="sp" fill="#ffd400">
       <rect x="58" y="18" width="4" height="10" rx="2"/>
       <rect x="38" y="24" width="4" height="8" rx="2" transform="rotate(-30 40 28)"/>
       <rect x="78" y="24" width="4" height="8" rx="2" transform="rotate(30 80 28)"/>
     </g>
     <text x="60" y="82" font-size="11" font-weight="800" fill="#9fb6c4" ${FONT}
       text-anchor="middle" letter-spacing="2">CLAP</text>`,
  ),
  sticker(
    "gg",
    "GG",
    `<style>.gg{animation:bob .6s ease-in-out infinite alternate}
      @keyframes bob{from{transform:translateY(5px)}to{transform:translateY(-6px)}}</style>
     <rect width="120" height="90" rx="8" fill="#122c20"/>
     <text class="gg" x="60" y="58" font-size="34" font-weight="800" fill="#3ddc97" ${FONT}
       text-anchor="middle" letter-spacing="1">GG</text>`,
  ),
  sticker(
    "love",
    "Amei",
    `<style>.hb{transform-origin:60px 48px;animation:beat .58s ease-in-out infinite alternate}
      @keyframes beat{from{transform:scale(.85)}to{transform:scale(1.12)}}</style>
     <rect width="120" height="90" rx="8" fill="#3a1626"/>
     <path class="hb" d="M60 68C40 55 32 46 32 38a13 13 0 0 1 28-8 13 13 0 0 1 28 8c0 8-8 17-28 30Z" fill="#ff4b7d"/>`,
  ),
  sticker(
    "rage",
    "Revolta",
    `<style>.rg{animation:shake .16s linear infinite}
      @keyframes shake{0%{transform:translate(-3px,1px)}50%{transform:translate(3px,-2px)}100%{transform:translate(-3px,1px)}}</style>
     <rect width="120" height="90" rx="8" fill="#3a1717"/>
     <g class="rg">
       <circle cx="60" cy="45" r="22" fill="#ff5c5c"/>
       <rect x="45" y="36" width="14" height="4.5" rx="2" fill="#3a1717" transform="rotate(18 52 38)"/>
       <rect x="61" y="36" width="14" height="4.5" rx="2" fill="#3a1717" transform="rotate(-18 68 38)"/>
       <path d="M50 56c6-5 14-5 20 0" stroke="#3a1717" stroke-width="4" fill="none" stroke-linecap="round"/>
     </g>
     <text x="60" y="82" font-size="11" font-weight="800" fill="#ff8f8f" ${FONT}
       text-anchor="middle" letter-spacing="2">RAGE</text>`,
  ),
  sticker(
    "wave",
    "Oi",
    `<style>.wv{transform-origin:60px 68px;animation:wv .5s ease-in-out infinite alternate}
      @keyframes wv{from{transform:rotate(-20deg)}to{transform:rotate(20deg)}}</style>
     <rect width="120" height="90" rx="8" fill="#1c2937"/>
     <g class="wv">
       <rect x="52" y="30" width="16" height="38" rx="8" fill="#ffd9b0"/>
       <rect x="42" y="34" width="9" height="22" rx="4.5" fill="#ffd9b0"/>
       <rect x="69" y="34" width="9" height="22" rx="4.5" fill="#ffd9b0"/>
     </g>
     <text x="60" y="84" font-size="11" font-weight="800" fill="#8fb0cc" ${FONT}
       text-anchor="middle" letter-spacing="2">OI!</text>`,
  ),
  sticker(
    "boom",
    "Explodiu",
    `<style>.bm{transform-origin:60px 45px;animation:bm .85s ease-out infinite}
      @keyframes bm{0%{transform:scale(.45);opacity:.35}65%{transform:scale(1.05);opacity:1}100%{transform:scale(1.28);opacity:0}}</style>
     <rect width="120" height="90" rx="8" fill="#332a12"/>
     <path class="bm" d="M60 12l7 17 18-7-7 18 17 7-17 7 7 18-18-7-7 17-7-17-18 7 7-18-17-7 17-7-7-18 18 7z" fill="#ffd400"/>`,
  ),
];

const GIF_BY_ID = new Map(GIF_SET.map((g) => [g.id, g]));

export function lookupGif(id) {
  return GIF_BY_ID.get(id) ?? null;
}

export const GIF_TOKEN = /\[gif:([a-z0-9_-]{1,24})\]/gi;

/** One emoji, including keycaps, skin tones and ZWJ families. */
export const EMOJI_RUN =
  /(?:\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})?(?:‍\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})?)*)+/gu;
