import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ChakraProvider, defaultSystem } from "@chakra-ui/react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { Layout } from "./components/Layout";
import { Products } from "./pages/Products";
import { ProductDetail } from "./pages/ProductDetail";
import { CartPage } from "./pages/CartPage";
import { Orders } from "./pages/Orders";
import { OrderDetail } from "./pages/OrderDetail";
import { Login } from "./pages/Login";
import { Register } from "./pages/Register";
import { useUser } from "./session";

function RequireUser({ children }: { children: React.ReactNode }) {
  return useUser() ? children : <Navigate to="/login" replace />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ChakraProvider value={defaultSystem}>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Products />} />
            <Route path="products/:id" element={<ProductDetail />} />
            <Route path="login" element={<Login />} />
            <Route path="register" element={<Register />} />
            <Route path="cart" element={<RequireUser><CartPage /></RequireUser>} />
            <Route path="orders" element={<RequireUser><Orders /></RequireUser>} />
            <Route path="orders/:id" element={<RequireUser><OrderDetail /></RequireUser>} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </ChakraProvider>
  </StrictMode>,
);
