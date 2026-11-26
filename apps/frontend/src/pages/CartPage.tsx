import { useState } from "react";
import { Button, Card, Flex, Heading, HStack, IconButton, NativeSelect, Stack, Table, Text } from "@chakra-ui/react";
import { useNavigate } from "react-router";
import { api, money, newId } from "../api";
import type { Cart, Order } from "../api";
import { ErrorAlert } from "../components/ErrorAlert";
import { reloadCart, setCart, useCart } from "../cart-store";

export function CartPage() {
  const cart = useCart();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  const run = async (fn: () => Promise<void>) => {
    setError(null);
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const checkout = () =>
    run(async () => {
      // The idempotency key makes a double-click (or a retry) create only one order.
      const order = await api<Order>("POST", "/orders", {}, { "idempotency-key": newId() });
      await reloadCart();
      navigate(`/orders/${order.id}`);
    });

  if (!cart) return <Text>Loading cart…</Text>;
  return (
    <Stack gap="6">
      <Heading size="2xl">Your cart</Heading>
      <ErrorAlert error={error} />
      {cart.items.length === 0 ? (
        <Card.Root>
          <Card.Body>
            <Text>Your cart is empty.</Text>
            <Button mt="4" alignSelf="start" onClick={() => navigate("/")}>
              Browse products
            </Button>
          </Card.Body>
        </Card.Root>
      ) : (
        <Card.Root>
          <Card.Body overflowX="auto">
            <Table.Root size="sm">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeader>Product</Table.ColumnHeader>
                  <Table.ColumnHeader>Price</Table.ColumnHeader>
                  <Table.ColumnHeader>Quantity</Table.ColumnHeader>
                  <Table.ColumnHeader textAlign="end">Total</Table.ColumnHeader>
                  <Table.ColumnHeader />
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {cart.items.map((i) => (
                  <Table.Row key={i.productId}>
                    <Table.Cell>
                      {i.emoji} {i.name}
                    </Table.Cell>
                    <Table.Cell>{money(i.unitPriceCents)}</Table.Cell>
                    <Table.Cell>
                      <NativeSelect.Root size="xs" width="20">
                        <NativeSelect.Field
                          value={i.quantity}
                          onChange={(e) => run(async () => setCart(await api<Cart>("PATCH", `/cart/items/${i.productId}`, { quantity: Number(e.target.value) })))}
                        >
                          {Array.from({ length: 20 }, (_, n) => (
                            <option key={n + 1} value={n + 1}>
                              {n + 1}
                            </option>
                          ))}
                        </NativeSelect.Field>
                        <NativeSelect.Indicator />
                      </NativeSelect.Root>
                    </Table.Cell>
                    <Table.Cell textAlign="end">{money(i.lineTotalCents)}</Table.Cell>
                    <Table.Cell textAlign="end">
                      <IconButton
                        aria-label={`Remove ${i.name}`}
                        size="xs"
                        variant="ghost"
                        onClick={() => run(async () => setCart(await api<Cart>("DELETE", `/cart/items/${i.productId}`)))}
                      >
                        ✕
                      </IconButton>
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          </Card.Body>
          <Card.Footer>
            <Flex w="full" justify="space-between" align="center" wrap="wrap" gap="3">
              <Text fontSize="xl" fontWeight="bold">
                Total {money(cart.totalCents)}
              </Text>
              <HStack>
                <Button variant="ghost" disabled={busy} onClick={() => run(async () => setCart(await api<Cart>("DELETE", "/cart")))}>
                  Empty cart
                </Button>
                <Button colorPalette="purple" loading={busy} onClick={checkout}>
                  Checkout
                </Button>
              </HStack>
            </Flex>
          </Card.Footer>
        </Card.Root>
      )}
    </Stack>
  );
}
