// v2's title bar names the store and register: "US Store · Front Counter" (row 14a).
export function storeRegisterTitle(storeName: string, boundRegisterId: string | null | undefined, registerName: string | null): string {
  return typeof boundRegisterId === 'string' ? `${storeName} · ${registerName ?? 'Register'}` : storeName;
}
