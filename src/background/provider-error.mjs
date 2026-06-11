export class ProviderError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
    this.details = details;
  }
}
