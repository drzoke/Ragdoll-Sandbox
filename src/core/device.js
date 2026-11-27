// What kind of device the game is running on (touch phone/tablet or desktop).
const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
const touchPoints = typeof navigator !== 'undefined' ? navigator.maxTouchPoints || 0 : 0;
const forced = /[?&]mobile=(1|0)/.exec(location.search);

const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
const mq = (q) => typeof matchMedia === 'function' && matchMedia(q).matches;
const desktopOS = /Windows NT|Macintosh|X11|CrOS|Linux x86_64/.test(ua) && !/Android/.test(ua);
const iPadOS = navigator.platform === 'MacIntel' && touchPoints > 1 && !mq('(any-pointer: fine)'); // iPad says it's a Mac

/** The browser says it's a phone or tablet (user agent / client hints). */
export const IS_MOBILE_UA = /Android|iPhone|iPad|iPod|Silk|Kindle|Opera Mini|IEMobile/i.test(ua)
  || (/Mobile/i.test(ua) && !desktopOS) || navigator.userAgentData?.mobile === true || iPadOS;

/** A mouse or trackpad is plugged in / built in (any pointer that can hover precisely). */
export const HAS_MOUSE = mq('(any-pointer: fine)') || mq('(any-hover: hover)');

/**
 * A phone or tablet: the browser says it's mobile and it has a touch screen, or (any other OS)
 * the only pointer is a finger. Computers with a touch screen AND a mouse/trackpad stay on
 * desktop controls. (?mobile=1 / ?mobile=0 forces it; the Touch controls setting can too, and
 * on Auto the game also follows whatever you use: touching the screen or using keys/mouse.)
 */
export const IS_TOUCH = forced ? forced[1] === '1'
  : IS_MOBILE_UA ? (touchPoints > 0 || coarse)
    : coarse && !HAS_MOUSE && touchPoints > 0;

/** iPhone / iPad (Safari has no fullscreen API on iPhone: Add to Home Screen instead). */
export const IS_IOS = /iP(hone|od|ad)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && touchPoints > 1);

/** Running from the home screen (installed web app): already fullscreen. */
export const IS_STANDALONE = (typeof matchMedia === 'function' && matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches) || navigator.standalone === true;
