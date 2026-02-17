import { createClient } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";

export async function getHost() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  let host = await prisma.host.findUnique({
    where: { supabaseUserId: user.id },
  });

  if (!host) {
    host = await prisma.host.create({
      data: {
        supabaseUserId: user.id,
        email: user.email ?? null,
        name: user.user_metadata?.full_name ?? null,
      },
    });
  }

  return host;
}
```

Save, then also remove the debug alerts from the login page — change the two alert lines back to just:
```
    console.log("verify ok");