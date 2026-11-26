import { useEffect, useState } from "react";
import { Badge, Box, Button, Card, Flex, Heading, HStack, Input, SimpleGrid, Skeleton, Text } from "@chakra-ui/react";
import { Link as RouterLink, useNavigate, useSearchParams } from "react-router";
import { api, money } from "../api";
import type { Cart, Product } from "../api";
import { ErrorAlert } from "../components/ErrorAlert";
import { setCart } from "../cart-store";
import { useUser } from "../session";

export function Products() {
  const [params, setParams] = useSearchParams();
  const category = params.get("category") ?? "";
  const q = params.get("q") ?? "";
  const [search, setSearch] = useState(q);
  const [products, setProducts] = useState<Product[] | null>(null);
  const [categories, setCategories] = useState<{ category: string; count: number }[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const user = useUser();
  const navigate = useNavigate();

  useEffect(() => {
    api<{ category: string; count: number }[]>("GET", "/catalog/categories").then(setCategories).catch(setError);
  }, []);

  useEffect(() => {
    setProducts(null);
    const qs = new URLSearchParams();
    if (category) qs.set("category", category);
    if (q) qs.set("q", q);
    api<{ items: Product[] }>("GET", `/catalog/products?${qs}`)
      .then((r) => setProducts(r.items))
      .catch(setError);
  }, [category, q]);

  const add = async (p: Product) => {
    if (!user) return navigate("/login");
    setAdding(p.id);
    setError(null);
    try {
      setCart(await api<Cart>("POST", "/cart/items", { productId: p.id, quantity: 1 }));
    } catch (e) {
      setError(e);
    } finally {
      setAdding(null);
    }
  };

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next);
  };

  return (
    <Box>
      <Flex justify="space-between" align={{ base: "stretch", md: "center" }} direction={{ base: "column", md: "row" }} gap="4" mb="6">
        <Heading size="2xl">Products</Heading>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setFilter("q", search.trim());
          }}
        >
          <HStack>
            <Input placeholder="Search products" value={search} onChange={(e) => setSearch(e.target.value)} bg="bg" maxW="xs" />
            <Button type="submit" variant="outline">
              Search
            </Button>
          </HStack>
        </form>
      </Flex>

      <HStack gap="2" mb="6" wrap="wrap">
        <Button size="xs" variant={category ? "outline" : "solid"} colorPalette="purple" onClick={() => setFilter("category", "")}>
          All
        </Button>
        {categories.map((c) => (
          <Button key={c.category} size="xs" variant={category === c.category ? "solid" : "outline"} colorPalette="purple" onClick={() => setFilter("category", c.category)}>
            {c.category} ({c.count})
          </Button>
        ))}
      </HStack>

      <ErrorAlert error={error} />

      <SimpleGrid columns={{ base: 1, sm: 2, md: 3, lg: 4 }} gap="5">
        {products === null
          ? Array.from({ length: 8 }, (_, i) => <Skeleton key={i} h="260px" borderRadius="lg" />)
          : products.map((p) => (
              <Card.Root key={p.id} overflow="hidden" variant="elevated">
                <RouterLink to={`/products/${p.id}`}>
                  <Flex h="120px" align="center" justify="center" bg="purple.subtle" fontSize="6xl">
                    {p.emoji}
                  </Flex>
                </RouterLink>
                <Card.Body gap="1">
                  <HStack justify="space-between">
                    <Badge variant="subtle">{p.category}</Badge>
                    {p.rating?.average != null && (
                      <Text fontSize="xs" color="fg.muted">
                        ★ {p.rating.average} ({p.rating.count})
                      </Text>
                    )}
                  </HStack>
                  <Card.Title asChild>
                    <RouterLink to={`/products/${p.id}`}>{p.name}</RouterLink>
                  </Card.Title>
                  <Text fontWeight="semibold">{money(p.priceCents)}</Text>
                </Card.Body>
                <Card.Footer>
                  <Button w="full" size="sm" colorPalette="purple" loading={adding === p.id} onClick={() => add(p)}>
                    Add to cart
                  </Button>
                </Card.Footer>
              </Card.Root>
            ))}
      </SimpleGrid>
      {products?.length === 0 && <Text color="fg.muted">No products match.</Text>}
    </Box>
  );
}
