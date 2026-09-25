/** The window width react-native-web's useWindowDimensions reports; jsdom lays nothing out, so it would read 0 (phone mode). */
export function setWindowWidth(width: number) {
  Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: width });
  window.dispatchEvent(new Event('resize'));
}
