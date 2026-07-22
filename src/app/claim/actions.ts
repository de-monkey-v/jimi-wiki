"use server";
import { redirect } from "next/navigation";
import { authMode } from "@/lib/auth-mode";
import {
  claimTailscaleOwner,
  getTailscaleIdentity,
  TailscaleClaimError,
} from "@/lib/tailscale-auth";

export async function claimTailscaleOwnerAction() {
  if (authMode() !== "tailscale") redirect("/login");
  const identity = await getTailscaleIdentity();
  if (identity.status !== "allowed") redirect(`/claim?error=${identity.status}`);
  try {
    await claimTailscaleOwner(identity.login);
  } catch (error) {
    if (error instanceof TailscaleClaimError) redirect(`/claim?error=${error.code}`);
    throw error;
  }
  redirect("/wikis");
}
