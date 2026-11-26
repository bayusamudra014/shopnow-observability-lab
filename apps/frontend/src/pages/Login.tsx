import { useState } from "react";
import { Button, Card, Code, Field, Heading, Input, Link, Stack, Text } from "@chakra-ui/react";
import { Link as RouterLink, useNavigate } from "react-router";
import { login } from "../session";
import { ErrorAlert } from "../components/ErrorAlert";

export function Login() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  return (
    <Card.Root maxW="sm" mx="auto" mt="10">
      <Card.Body>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              await login(username.trim(), password);
              navigate("/");
            } catch (err) {
              setError(err);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Stack gap="4">
            <Heading size="xl">Sign in</Heading>
            <Field.Root required>
              <Field.Label>Username or email</Field.Label>
              <Input autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
            </Field.Root>
            <Field.Root required>
              <Field.Label>Password</Field.Label>
              <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field.Root>
            <ErrorAlert error={error} />
            <Button type="submit" colorPalette="purple" loading={busy}>
              Sign in
            </Button>
            <Text fontSize="sm" color="fg.muted">
              New here?{" "}
              <Link asChild colorPalette="purple">
                <RouterLink to="/register">Create an account</RouterLink>
              </Link>
            </Text>
            <Text fontSize="sm" color="fg.muted">
              Demo accounts: <Code>shopper001</Code> … <Code>shopper100</Code> and <Code>instructor</Code>. The deploy script prints their passwords.
            </Text>
          </Stack>
        </form>
      </Card.Body>
    </Card.Root>
  );
}
