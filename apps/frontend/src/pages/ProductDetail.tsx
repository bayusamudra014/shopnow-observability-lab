import { useEffect, useState } from "react";
import { Badge, Box, Button, Card, Flex, Heading, HStack, NativeSelect, Separator, Stack, Text } from "@chakra-ui/react";
import { useNavigate, useParams } from "react-router";
import { api, money } from "../api";
import type { Cart, Product } from "../api";
import { ErrorAlert } from "../components/ErrorAlert";
import { setCart } from "../cart-store";
import { useUser } from "../session";

export function ProductDetail() {
  const { id = "" } = useParams();
  const [product, setProduct] = useState<Product | null>(null);
  const [stock, setStock] = useState<number | null>(null);
  const [qty, setQty] = useState(1);
  const [error, setError] = useState<unknown>(null);
  const [added, setAdded] = useState(false);
  const [busy, setBusy] = useState(false);
  const user = useUser();
  const navigate = useNavigate();

  useEffect(() => {
    api<Product>("GET", `/catalog/products/${id}`).then(setProduct).catch(setError);
    api<{ available: number }>("GET", `/inventory/stock/${id}`)
      .then((s) => setStock(s.available))
      .catch(() => setStock(null));
  }, [id]);

  const add = async () => {
    if (!user) return navigate("/login");
    setBusy(true);
    setError(null);
    try {
      setCart(await api<Cart>("POST", "/cart/items", { productId: id, quantity: qty }));
      setAdded(true);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  if (!product) return <ErrorAlert error={error} />;
  return (
    <Stack gap="6">
      <Card.Root>
        <Flex direction={{ base: "column", md: "row" }}>
          <Flex minW={{ md: "280px" }} h={{ base: "180px", md: "auto" }} align="center" justify="center" bg="purple.subtle" fontSize="8xl">
            {product.emoji}
          </Flex>
          <Card.Body gap="3">
            <HStack>
              <Badge>{product.category}</Badge>
              <Text fontSize="sm" color="fg.muted">
                SKU {product.sku}
              </Text>
            </HStack>
            <Heading size="2xl">{product.name}</Heading>
            <Text color="fg.muted">{product.description}</Text>
            <Text fontSize="2xl" fontWeight="bold">
              {money(product.priceCents)}
            </Text>
            <Text fontSize="sm" color={stock !== null && stock < 10 ? "orange.fg" : "fg.muted"}>
              {stock === null ? "Stock unknown" : stock === 0 ? "Out of stock" : `${stock} in stock`}
            </Text>
            <HStack>
              <NativeSelect.Root size="sm" width="24">
                <NativeSelect.Field value={qty} onChange={(e) => setQty(Number(e.target.value))}>
                  {Array.from({ length: 10 }, (_, i) => (
                    <option key={i + 1} value={i + 1}>
                      {i + 1}
                    </option>
                  ))}
                </NativeSelect.Field>
                <NativeSelect.Indicator />
              </NativeSelect.Root>
              <Button colorPalette="purple" loading={busy} onClick={add} disabled={stock === 0}>
                Add to cart
              </Button>
              {added && (
                <Button variant="outline" onClick={() => navigate("/cart")}>
                  Go to cart
                </Button>
              )}
            </HStack>
            <ErrorAlert error={error} />
          </Card.Body>
        </Flex>
      </Card.Root>

      <Box>
        <Heading size="lg" mb="3">
          Reviews {product.rating?.average != null && `· ★ ${product.rating.average} from ${product.rating.count}`}
        </Heading>
        <Card.Root>
          <Card.Body>
            {product.reviews?.map((r, i) => (
              <Box key={i}>
                {i > 0 && <Separator my="3" />}
                <Text fontWeight="medium">{"★".repeat(r.rating) + "☆".repeat(5 - r.rating)}</Text>
                <Text color="fg.muted">{r.comment}</Text>
              </Box>
            ))}
          </Card.Body>
        </Card.Root>
      </Box>
    </Stack>
  );
}
