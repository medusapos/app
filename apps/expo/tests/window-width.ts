/** The window width react-native-web's useWindowDimensions reports; jsdom lays nothing out, so it would read 0 (phone mode). */
export function setWindowWidth(width: number, height?: number) {
  Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: width });
  // The height reads 0 too unless given; TallyUI 3.14.0's cart shows its Price column only on a window 480 or more high.
  if (height !== undefined) Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: height });
  window.dispatchEvent(new Event('resize'));
}
