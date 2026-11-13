import enUS from "./locales/en-US.json";
import zhCN from "./locales/zh-CN.json";

export const locales = {
  "zh-CN": zhCN,
  "en-US": enUS,
} as const;

export type LanguageCode = keyof typeof locales;
export type LocaleMessages = (typeof locales)[LanguageCode];

export function resolveMessages(language: string): LocaleMessages {
  return locales[language as LanguageCode] ?? locales["zh-CN"];
}

/** Language passed to embedded module pages by the shell (see embedded_modules.rs). */
export function moduleMessages(): LocaleMessages {
  try {
    return resolveMessages(new URLSearchParams(window.location.search).get("lang") ?? "");
  } catch {
    return resolveMessages("");
  }
}

export function t(messages: LocaleMessages, key: keyof LocaleMessages, vars?: Record<string, string>) {
  const template = messages[key];

  if (!vars) return template;

  return Object.entries(vars).reduce((output, [name, value]) => {
    return output.split(`{${name}}`).join(value);
  }, template);
}
