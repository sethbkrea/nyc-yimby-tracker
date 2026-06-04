import { redirect } from "next/navigation";

// Tabs are now client-side on the index page; keep this path working as a
// deep link by redirecting to the corresponding tab.
export default function PropertiesRedirect() {
  redirect("/#properties");
}
