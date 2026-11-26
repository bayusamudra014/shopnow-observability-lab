import { Alert, Code } from "@chakra-ui/react";
import { ApiError } from "../api";

/** Shows an API error together with its request id, which students can search for in SigNoz. */
export function ErrorAlert({ error }: { error: unknown }) {
  if (!error) return null;
  const e = error as Error;
  return (
    <Alert.Root status="error" my="4">
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Title>{e instanceof ApiError ? `Request failed (${e.status})` : "Something went wrong"}</Alert.Title>
        <Alert.Description>
          {e.message}
          {e instanceof ApiError && e.requestId && (
            <>
              {" "}
              · request id <Code size="sm">{e.requestId}</Code>
            </>
          )}
        </Alert.Description>
      </Alert.Content>
    </Alert.Root>
  );
}
