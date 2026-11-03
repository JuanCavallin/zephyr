/**
 * Transport-level failures: the network, a provider that is down or
 * overloaded, a connection that closed. These mean the agent never got to
 * work. A refused request, a bad route or a policy error is NOT one of these,
 * and retrying it would only repeat it.
 */
export function isNetworkFailure(message: string): boolean {
  return /\b(?:ECONN\w+|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|UND_ERR_\w+)\b|socket hang up|fetch failed|network|connection (?:error|closed|reset|refused|lost)|timed out|timeout|overloaded|rate.?limit|too many requests|service unavailable|bad gateway|\b(?:429|500|502|503|504|529)\b/i.test(
    message,
  );
}
