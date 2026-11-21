import type { ReactNode } from "react"
import { Link } from "react-router-dom"
import { Logo } from "@/components/brand/Logo"
import { PublicFooter } from "./PublicFooter"
import { cn } from "@/lib/utils"

export function AuthLayout({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="flex min-h-screen flex-col">
      <main className="flex flex-1 items-center justify-center bg-[var(--color-canvas)] px-4 py-10">
        <div className={cn("w-full rounded-2xl border border-[var(--color-border)] bg-white p-6 shadow-[0_1px_2px_rgb(20_17_2/0.05)] sm:p-8", wide ? "max-w-md" : "max-w-[400px]")}>
          <div className="mb-6 flex justify-center">
            <Link to="/" aria-label="SocratiQ home" className="rounded-[var(--radius-sm)]">
              <Logo size="sidebar" />
            </Link>
          </div>
          {children}
        </div>
      </main>
      <PublicFooter compact />
    </div>
  )
}
