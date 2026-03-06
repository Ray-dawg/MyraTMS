import { NextRequest, NextResponse } from "next/server"
import { TEMPLATES, type ImportType } from "@/lib/import/types"

const VALID_TYPES: ImportType[] = ["carriers", "shippers", "loads"]

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ type: string }> }
) {
  const { type } = await params

  if (!VALID_TYPES.includes(type as ImportType)) {
    return NextResponse.json(
      { error: `Invalid type. Must be one of: ${VALID_TYPES.join(", ")}` },
      { status: 400 }
    )
  }

  const template = TEMPLATES[type as ImportType]

  return new NextResponse(template, {
    status: 200,
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="${type}_template.csv"`,
    },
  })
}
