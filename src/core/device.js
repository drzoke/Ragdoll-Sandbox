// What kind of device the game is running on (touch phone/tablet or desktop).
const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
const touchPoints = typeof navigator !== 'undefined' ? navigator.maxTouchPoints || 0 : 0;
const forced = /[?&]mobile=(1|0)/.exec(location.search);

const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
/** The browser says it's a phone or tablet (user agent / client hints). */
export const IS_MOBILE_UA = /Android|iPhone|iPad|iPod|Mobile|Silk|Kindle|Opera Mini|IEMobile/i.test(ua) || navigator.userAgentData?.mobile === true
  || (navigator.platform === 'MacIntel' && touchPoints > 1); // iPadOS reports itself as a Mac

/**
 * A phone or tablet: the browser says it's mobile, or the main pointer is a finger on a touch
 * screen. Touch laptops with a mouse/trackpad stay on desktop controls. (?mobile=1 / ?mobile=0
 * forces it; the Touch controls setting can also force it on or off.)
 */
export const IS_TOUCH = forced ? forced[1] === '1' : (IS_MOBILE_UA && touchPoints > 0) || (coarse && (touchPoints > 0 || 'ontouchstart' in window));

/** iPhone / iPad (Safari has no fullscreen API on iPhone: Add to Home Screen instead). */
export const IS_IOS = /iP(hone|od|ad)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && touchPoints > 1);

/** Running from the home screen (installed web app): already fullscreen. */
export const IS_STANDALONE = (typeof matchMedia === 'function' && matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches) || navigator.standalone === true;
