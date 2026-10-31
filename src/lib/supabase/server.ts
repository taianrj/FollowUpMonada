import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { databaseProvider, d1ServerClient } from '@/lib/database/runtime';

export async function createClient() {
  if (databaseProvider() === 'd1') {
    return await d1ServerClient() as unknown as Awaited<ReturnType<typeof createNativeClient>>;
  }
  return createNativeClient();
}

async function createNativeClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Isso pode ser ignorado se for chamado de um Server Component
          }
        },
      },
    }
  );
}
