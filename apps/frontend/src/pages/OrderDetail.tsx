import { useEffect, useState } from "react";
import { Alert, Card, Code, DataList, Heading, HStack, Spinner, Stack, Table, Text } from "@chakra-ui/react";
import { useParams } from "react-router";
import { api, money } from "../api";
import type { Order } from "../api";
import { ErrorAlert } from "../components/ErrorAlert";
import { StatusBadge } from "./Orders";

const open = (o: Order | null) => !o || o.status === "created" || o.status === "awaiting_payment";

export function OrderDetail() {
  const { id = "" } = useParams();
  const [order, setOrder] = useState<Order | null>(null);
  const [error, setError] = useState<unknown>(null);

  // The payment result arrives asynchronously (provider webhook -> Kafka), so poll.
  useEffect(() => {
    let stop = false;
    let timer: number | undefined;
    const load = async () => {
      try {
        const o = await api<Order>("GET", `/orders/${id}`);
        if (stop) return;
        setOrder(o);
        if (open(o)) timer = window.setTimeout(load, 1500);
      } catch (e) {
        setError(e);
      }
    };
    void load();
    return () => {
      stop = true;
      window.clearTimeout(timer);
    };
  }, [id]);

  if (!order) return error ? <ErrorAlert error={error} /> : <Spinner />;
  return (
    <Stack gap="6">
      <HStack gap="3" wrap="wrap">
        <Heading size="2xl">Order {order.id.slice(0, 8)}</Heading>
        <StatusBadge status={order.status} />
        {open(order) && <Spinner size="sm" />}
      </HStack>

      {order.status === "awaiting_payment" && (
        <Alert.Root status="info">
          <Alert.Indicator />
          <Alert.Title>Waiting for the payment provider to confirm your payment…</Alert.Title>
        </Alert.Root>
      )}
      {order.status === "confirmed" && (
        <Alert.Root status="success">
          <Alert.Indicator />
          <Alert.Title>Payment received. Your order is confirmed. A confirmation email was sent.</Alert.Title>
        </Alert.Root>
      )}
      {order.status === "cancelled" && (
        <Alert.Root status="error">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>Order cancelled</Alert.Title>
            <Alert.Description>
              Reason: <Code>{order.failureReason}</Code>
            </Alert.Description>
          </Alert.Content>
        </Alert.Root>
      )}

      <Card.Root>
        <Card.Body gap="4">
          <DataList.Root orientation="horizontal" size="sm">
            <DataList.Item>
              <DataList.ItemLabel>Order id</DataList.ItemLabel>
              <DataList.ItemValue>
                <Code>{order.id}</Code>
              </DataList.ItemValue>
            </DataList.Item>
            <DataList.Item>
              <DataList.ItemLabel>Payment id</DataList.ItemLabel>
              <DataList.ItemValue>{order.paymentId ? <Code>{order.paymentId}</Code> : "–"}</DataList.ItemValue>
            </DataList.Item>
            <DataList.Item>
              <DataList.ItemLabel>Placed</DataList.ItemLabel>
              <DataList.ItemValue>{new Date(order.createdAt).toLocaleString()}</DataList.ItemValue>
            </DataList.Item>
            <DataList.Item>
              <DataList.ItemLabel>Last update</DataList.ItemLabel>
              <DataList.ItemValue>{new Date(order.updatedAt).toLocaleString()}</DataList.ItemValue>
            </DataList.Item>
          </DataList.Root>
          <Text fontSize="sm" color="fg.muted">
            Tip: search SigNoz traces for the attribute <Code>order.id = {order.id}</Code>.
          </Text>
          <Table.Root size="sm">
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeader>Item</Table.ColumnHeader>
                <Table.ColumnHeader>Qty</Table.ColumnHeader>
                <Table.ColumnHeader textAlign="end">Total</Table.ColumnHeader>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {order.items.map((i) => (
                <Table.Row key={i.productId}>
                  <Table.Cell>{i.name}</Table.Cell>
                  <Table.Cell>{i.quantity}</Table.Cell>
                  <Table.Cell textAlign="end">{money(i.unitPriceCents * i.quantity)}</Table.Cell>
                </Table.Row>
              ))}
              <Table.Row>
                <Table.Cell colSpan={2} fontWeight="bold">
                  Total
                </Table.Cell>
                <Table.Cell textAlign="end" fontWeight="bold">
                  {money(order.totalCents)}
                </Table.Cell>
              </Table.Row>
            </Table.Body>
          </Table.Root>
        </Card.Body>
      </Card.Root>
    </Stack>
  );
}
