import { useState } from "react";
import { Button, Card, Field, Heading, Input, Link, Stack, Text } from "@chakra-ui/react";
import { Link as RouterLink, useNavigate } from "react-router";
import { register } from "../session";
import { ErrorAlert } from "../components/ErrorAlert";

const USERNAME = /^[a-z0-9._-]{3,32}$/;

export function Register() {
  const [form, setForm] = useState({ name: "", username: "", email: "", password: "", confirm: "" });
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const blur = (k: string) => () => setTouched((t) => ({ ...t, [k]: true }));

  const problems: Partial<Record<keyof typeof form, string>> = {};
  if (!form.name.trim()) problems.name = "Enter your name";
  if (!USERNAME.test(form.username.trim().toLowerCase())) problems.username = "3–32 characters: letters, digits, '.', '_' or '-'";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) problems.email = "Enter a valid email address";
  if (form.password.length < 8) problems.password = "At least 8 characters";
  if (form.confirm !== form.password) problems.confirm = "Passwords do not match";
  const show = (k: keyof typeof form) => (touched[k] ? problems[k] : undefined);

  return (
    <Card.Root maxW="sm" mx="auto" mt="10">
      <Card.Body>
        <form
          noValidate
          onSubmit={async (e) => {
            e.preventDefault();
            setTouched({ name: true, username: true, email: true, password: true, confirm: true });
            if (Object.keys(problems).length > 0) return;
            setBusy(true);
            setError(null);
            try {
              await register({ name: form.name.trim(), username: form.username.trim().toLowerCase(), email: form.email.trim(), password: form.password });
              navigate("/");
            } catch (err) {
              setError(err);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Stack gap="4">
            <Heading size="xl">Create an account</Heading>
            <Field.Root required invalid={Boolean(show("name"))}>
              <Field.Label>Full name</Field.Label>
              <Input autoComplete="name" value={form.name} onChange={set("name")} onBlur={blur("name")} />
              <Field.ErrorText>{show("name")}</Field.ErrorText>
            </Field.Root>
            <Field.Root required invalid={Boolean(show("username"))}>
              <Field.Label>Username</Field.Label>
              <Input autoComplete="username" value={form.username} onChange={set("username")} onBlur={blur("username")} />
              {show("username") ? <Field.ErrorText>{show("username")}</Field.ErrorText> : <Field.HelperText>Used to sign in</Field.HelperText>}
            </Field.Root>
            <Field.Root required invalid={Boolean(show("email"))}>
              <Field.Label>Email</Field.Label>
              <Input type="email" autoComplete="email" value={form.email} onChange={set("email")} onBlur={blur("email")} />
              {show("email") ? <Field.ErrorText>{show("email")}</Field.ErrorText> : <Field.HelperText>Order confirmations go here (Mailpit)</Field.HelperText>}
            </Field.Root>
            <Field.Root required invalid={Boolean(show("password"))}>
              <Field.Label>Password</Field.Label>
              <Input type="password" autoComplete="new-password" value={form.password} onChange={set("password")} onBlur={blur("password")} />
              <Field.ErrorText>{show("password")}</Field.ErrorText>
            </Field.Root>
            <Field.Root required invalid={Boolean(show("confirm"))}>
              <Field.Label>Confirm password</Field.Label>
              <Input type="password" autoComplete="new-password" value={form.confirm} onChange={set("confirm")} onBlur={blur("confirm")} />
              <Field.ErrorText>{show("confirm")}</Field.ErrorText>
            </Field.Root>
            <ErrorAlert error={error} />
            <Button type="submit" colorPalette="purple" loading={busy}>
              Create account
            </Button>
            <Text fontSize="sm" color="fg.muted">
              Already have an account?{" "}
              <Link asChild colorPalette="purple">
                <RouterLink to="/login">Sign in</RouterLink>
              </Link>
            </Text>
          </Stack>
        </form>
      </Card.Body>
    </Card.Root>
  );
}
