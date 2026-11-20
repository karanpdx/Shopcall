export function GET() {
  return Response.json({ service: "shopcall", status: "scaffold", integrationsVerified: false });
}
