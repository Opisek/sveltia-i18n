declare global {
  namespace Intl {
    class MessageFormat {
      constructor(locale: string | string[], message: string, options?: Record<string, unknown>);
      format(values?: Record<string, unknown>): string;
    }
  }
}

export {};
