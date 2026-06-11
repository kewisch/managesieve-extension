const URL_SCHEME_PATTERN = /^[a-z][a-z\d+.-]*:/i;

export function normalizeJmapSessionUrl(serverAddress) {
  const trimmedAddress = serverAddress?.trim() || "";
  if (!trimmedAddress) {
    return "";
  }

  const addressWithScheme = URL_SCHEME_PATTERN.test(trimmedAddress) ? trimmedAddress : `https://${trimmedAddress}`;
  const url = new URL(addressWithScheme);

  if (url.pathname == "/" && !url.search && !url.hash) {
    url.pathname = "/.well-known/jmap";
  }

  return url.toString();
}
