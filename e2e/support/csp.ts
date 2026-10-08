// The production build carries a Content-Security-Policy <meta> (scripts/vite-plugins.ts). Every test
// collects the violations the page reports, so a blocked script, style, fetch or worker fails the suite
// instead of silently breaking a feature.
import type { BrowserContext } from '@playwright/test';

const BINDING = '__e2eCspViolation';

/** Starts recording the CSP violations of every page in `context`; the returned list fills as they happen. */
export async function watchCsp(context: BrowserContext): Promise<string[]> {
  const violations: string[] = [];
  await context.exposeBinding(BINDING, (_source, text: string) => {
    violations.push(text);
  });
  await context.addInitScript(binding => {
    document.addEventListener('securitypolicyviolation', e => {
      const report = (window as unknown as Record<string, (text: string) => void>)[binding];
      report?.(`${e.effectiveDirective}: blocked ${e.blockedURI || 'inline'} (${e.sourceFile || 'page'}:${e.lineNumber}) ${e.sample}`.trim());
    });
  }, BINDING);
  return violations;
}
