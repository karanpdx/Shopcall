/** Compare the actual mail recipient, allowing ordinary inquiry subject/body text. */
export function approvedContactLink(href: string, expectedEmail: string): boolean {
  try {
    const url = new URL(href);
    return url.protocol === "mailto:" && !url.hash && decodeURIComponent(url.pathname) === expectedEmail
      && [...url.searchParams.keys()].every(key => ["subject", "body"].includes(key.toLowerCase()));
  } catch { return false; }
}

// The browser check uses the same implementation as the parser unit tests.
export const approvedContactBrowserScript = `globalThis.__shopcallApprovedContact = ${approvedContactLink.toString()};`;
declare global {
  interface Window { __shopcallApprovedContact: typeof approvedContactLink }
}
