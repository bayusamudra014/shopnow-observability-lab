import { Badge, Box, Button, Container, Flex, HStack, Link, Text } from "@chakra-ui/react";
import { Link as RouterLink, Outlet, useNavigate } from "react-router";
import { logout, useUser } from "../session";
import { useCart } from "../cart-store";

function NavLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <Link asChild fontWeight="medium" color="fg.muted" _hover={{ color: "fg", textDecoration: "none" }}>
      <RouterLink to={to}>{children}</RouterLink>
    </Link>
  );
}

export function Layout() {
  const user = useUser();
  const cart = useCart();
  const navigate = useNavigate();
  return (
    <Box minH="100vh" bg="bg.subtle">
      <Box as="header" bg="bg" borderBottomWidth="1px" position="sticky" top="0" zIndex="10">
        <Container maxW="6xl">
          <Flex h="14" align="center" gap="6" wrap="wrap">
            <Link asChild fontWeight="bold" fontSize="lg" _hover={{ textDecoration: "none" }}>
              <RouterLink to="/">🛒 ShopNow</RouterLink>
            </Link>
            <HStack gap="5" flex="1">
              <NavLink to="/">Products</NavLink>
              {user && <NavLink to="/orders">Orders</NavLink>}
            </HStack>
            <HStack gap="3">
              {user && (
                <Button size="sm" variant="outline" onClick={() => navigate("/cart")}>
                  Cart
                  {cart && cart.itemCount > 0 && (
                    <Badge colorPalette="purple" variant="solid" ml="1">
                      {cart.itemCount}
                    </Badge>
                  )}
                </Button>
              )}
              {user ? (
                <>
                  <Text fontSize="sm" color="fg.muted" display={{ base: "none", md: "block" }}>
                    {user.username}
                  </Text>
                  <Button size="sm" variant="ghost" onClick={() => { logout(); navigate("/"); }}>
                    Sign out
                  </Button>
                </>
              ) : (
                <>
                  <Button size="sm" variant="ghost" onClick={() => navigate("/register")}>
                    Register
                  </Button>
                  <Button size="sm" colorPalette="purple" onClick={() => navigate("/login")}>
                    Sign in
                  </Button>
                </>
              )}
            </HStack>
          </Flex>
        </Container>
      </Box>
      <Container maxW="6xl" py="8">
        <Outlet />
      </Container>
    </Box>
  );
}
