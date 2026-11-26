export const BEWRIGHT_PACKAGE = 'bewright';

export function toolPackageImport(specifier: string): string | undefined {
  if (specifier === BEWRIGHT_PACKAGE || specifier.startsWith(BEWRIGHT_PACKAGE + '/')) return specifier;
  if (specifier === 'blockwright' || specifier.startsWith('blockwright/'))
    return BEWRIGHT_PACKAGE + specifier.slice('blockwright'.length);
  return undefined;
}
