import { requestFormInput } from "@openai/mcp-extensions/server";

export function nativeFormAvailable(context) {
  const envelope = context.mcpReq.envelope;
  const capabilities = envelope?.["io.modelcontextprotocol/clientCapabilities"];
  return envelope?.["io.modelcontextprotocol/protocolVersion"] >= "2026-07-28"
    && capabilities?.elicitation?.form !== undefined
    && capabilities?.extensions?.["openai/elicitation"]?.form !== undefined;
}

export function requestQuestion(context, question) {
  const field = { type: "string", title: question.title };
  if (question.type === "choice") {
    field.oneOf = question.options.map((option) => ({ const: option.value, title: option.label }));
  } else if (question.type === "date") {
    field.format = "date";
  } else {
    field.minLength = 1;
    field.maxLength = 120;
  }
  return requestFormInput(context, {
    key: `answer_${question.id}`,
    mode: "form", message: question.title,
    requestedSchema: { type: "object", properties: { [question.id]: field }, required: [question.id] },
  });
}
