// memo() for Preact function components without pulling in preact/compat: the wrapped component
// re-renders only when a prop changed (shallow comparison, or `equal`).
import { createElement, type Component, type FunctionComponent, type VNode } from 'preact';

export function shallowEqual<P extends object>(a: P, b: P): boolean {
  for (const key in a) if (key !== 'children' && !(key in b)) return false;
  for (const key in b) if (key !== 'children' && a[key] !== b[key]) return false;
  return true;
}

export function memo<P extends object>(component: FunctionComponent<P>, equal: (prev: P, next: P) => boolean = shallowEqual): FunctionComponent<P> {
  function Memoed(this: Component<P>, props: P): VNode {
    this.shouldComponentUpdate = (next: Readonly<P>): boolean => !equal(this.props as P, next as P);
    return createElement(component as FunctionComponent<object>, props);
  }
  Memoed.displayName = `Memo(${component.displayName ?? component.name})`;
  return Memoed as unknown as FunctionComponent<P>;
}
