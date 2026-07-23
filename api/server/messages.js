import { handleApiRequest } from "../../lib/api-router.js";

export default async function handler(request, response) {
  await handleApiRequest(request, response);
}
