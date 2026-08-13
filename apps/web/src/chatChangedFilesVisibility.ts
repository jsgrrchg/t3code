export function resolveShowChangedFilesInChat(input: {
  readonly desktop: boolean;
  readonly setting: boolean;
}): boolean {
  return !input.desktop || input.setting;
}
