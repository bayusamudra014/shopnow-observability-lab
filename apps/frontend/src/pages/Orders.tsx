import { useEffect, useState } from "react";
import { Badge, Card, Code, Heading, Link, Stack, Table, Text } from "@chakra-ui/react";
import { Link as RouterLink } from "react-router";
import { api, money } from "../api";
import type { Order } from "../api";
import { ErrorAlert } from "../components/ErrorAlert";

const palette: Record<Order["status"], string> = {
  created: "gray",
  awaiting_payment: "orange",
  confirmed: "green",
  cancelled: "red",
};

export function StatusBadge({ status }: { status: Order["status"] }) {
  return (
    <Badge colorPalette={palette[status]} variant="solid">
      {status.replace("_", " ")}
    </Badge>
  );
}

export function Orders() {
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    api<{ items: Order[] }>("GET", "/orders")
      .then((r) => setOrders(r.items))
      .catch(setError);
  }, []);

  return (
    <Stack gap="6">
      <Heading size="2xl">Your orders</Heading>
      <ErrorAlert error={error} />
      {orders?.length === 0 && <Text color="fg.muted">No orders yet.</Text>}
      {orders && orders.length > 0 && (
        <Card.Root>
          <Card.Body overflowX="auto">
            <Table.Root size="sm" interactive>
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeader>Order</Table.ColumnHeader>
                  <Table.ColumnHeader>Placed</Table.ColumnHeader>
                  <Table.ColumnHeader>Items</Table.ColumnHeader>
                  <Table.ColumnHeader>Status</Table.ColumnHeader>
                  <Table.ColumnHeader textAlign="end">Total</Table.ColumnHeader>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {orders.map((o) => (
                  <Table.Row key={o.id}>
                    <Table.Cell>
                      <Link asChild colorPalette="purple">
                        <RouterLink to={`/orders/${o.id}`}>
                          <Code>{o.id.slice(0, 8)}</Code>
                        </RouterLink>
                      </Link>
                    </Table.Cell>
                    <Table.Cell>{new Date(o.createdAt).toLocaleString()}</Table.Cell>
                    <Table.Cell>{o.items.reduce((n, i) => n + i.quantity, 0)}</Table.Cell>
                    <Table.Cell>
                      <StatusBadge status={o.status} />
                    </Table.Cell>
                    <Table.Cell textAlign="end">{money(o.totalCents)}</Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          </Card.Body>
        </Card.Root>
      )}
    </Stack>
  );
}
