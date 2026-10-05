/**
 * Host half of the Pomodoro clock bundle.
 *
 * The clock itself runs entirely in the browser entry (`./client`): the
 * countdown, its settings, its persistence, and the floating widget it mounts
 * into the frame-wide `shell.overlay` layer. This half exists so the Loader row
 * is addressable — the plugin is listed, enable/disable-able, and disposable
 * through the ordinary profile composition — without adding Host services the
 * feature does not need.
 */
export function apply() {}
