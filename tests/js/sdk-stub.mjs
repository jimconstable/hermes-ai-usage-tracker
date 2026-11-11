// Minimal stand-in for `@hermes/plugin-sdk` and `react/jsx-runtime` so `desktop/plugin.js`
// imports under plain Node. Only the logic exports are exercised here; rendering is covered by
// the browser demo against the real Hermes webapp (see tests/e2e/README.md).
export function atom(initial) {
  let value = initial
  return { get: () => value, set: next => { value = next } }
}
const component = name => props => ({ name, props })
export const Badge = component('Badge')
export const Button = component('Button')
export const Codicon = component('Codicon')
export const EmptyState = component('EmptyState')
export const ErrorState = component('ErrorState')
export const ScrollArea = component('ScrollArea')
export const Select = component('Select')
export const SelectContent = component('SelectContent')
export const SelectItem = component('SelectItem')
export const SelectTrigger = component('SelectTrigger')
export const SelectValue = component('SelectValue')
export const Separator = component('Separator')
export const Skeleton = component('Skeleton')
export const ROUTES_AREA = 'routes'
export const SIDEBAR_NAV_AREA = 'sidebar-nav'
export const STATUSBAR_AREAS = { left: 'status-left', right: 'status-right' }
export const cn = (...parts) => parts.filter(Boolean).join(' ')
export const haptic = () => {}
export const host = { navigate: () => {}, state: { profile: { get: () => globalThis.__activeProfile ?? '' } } }
export const useQuery = () => ({})
export const useValue = store => store.get()
export const useState = initial => [initial, () => {}]
export const jsx = (type, props) => ({ type, props })
export const jsxs = jsx
