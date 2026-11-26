import { useEffect, useSyncExternalStore } from "react";
import { api } from "./api";
import type { Cart } from "./api";
import { useUser } from "./session";

/** Shared cart state so the header badge updates when items are added anywhere. */
let cart: Cart | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function setCart(c: Cart | null) {
  cart = c;
  emit();
}

export async function reloadCart() {
  try {
    setCart(await api<Cart>("GET", "/cart"));
  } catch {
    setCart(null);
  }
}

export function useCart() {
  const user = useUser();
  useEffect(() => {
    if (user) void reloadCart();
    else setCart(null);
  }, [user?.id]);
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => cart,
  );
}
