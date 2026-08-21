/**
 * Naming convention: turn a raw preview identifier into { component, state }.
 *
 * Precedence:
 * 1. An explicit preview display name containing "/" splits into component/state
 *    (e.g. @Preview(name = "Button/Disabled")).
 * 2. An explicit preview display name without "/" becomes the state; the
 *    component is derived from the function name.
 * 3. Otherwise the function name minus a leading/trailing "Preview" is the
 *    component and the state is "Default".
 */
export interface ComponentState {
  component: string;
  state: string;
}

export function parsePreviewName(functionName: string, displayName?: string): ComponentState {
  const component = stripPreview(functionName);
  const name = displayName?.trim();
  if (name) {
    const slash = name.indexOf('/');
    if (slash > 0 && slash < name.length - 1) {
      return {
        component: spaceCamelCase(name.slice(0, slash).trim()),
        state: name.slice(slash + 1).trim(),
      };
    }
    return { component, state: name };
  }
  return { component, state: 'Default' };
}

function stripPreview(functionName: string): string {
  let n = functionName;
  if (n.endsWith('Preview')) n = n.slice(0, -'Preview'.length);
  else if (n.startsWith('Preview')) n = n.slice('Preview'.length);
  if (n.length === 0) n = functionName;
  return spaceCamelCase(n);
}

/** "PrimaryButton" -> "Primary Button"; leaves acronym runs intact ("URLBar" -> "URL Bar") */
export function spaceCamelCase(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .trim();
}
