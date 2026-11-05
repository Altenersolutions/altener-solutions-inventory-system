# Importing the BUZZ Part ID sheet

1. BOM > **Import BOM from Excel** > model `BUZZ`, revision `REV-A`, pick your workbook, keep **dry run** ticked.
   Suppliers: choose "Create the suppliers that do not exist yet" the first time.
2. Read the summary before importing for real:
   - **Part IDs**: complete 12-digit IDs become the real Part ID. Incomplete drafts (e.g. 901016037) and zero placeholders get a temporary
     number (TMP-xxxxx); the draft is kept as a note on the part ("draft 901016037").
   - **Quantities**: lines with a blank quantity or a status other than Finalized are *not verified*.
   - **Suppliers**: named suppliers, prices found, and any that could not be linked.
   - **IDs used for different parts**: sheet mistakes (for example LH/RH parts sharing one running number).
3. Import for real. The BOM is a DRAFT. Check it with **Quantity check** and **Cost**.
4. Verify quantities in bulk: Quantity check > Download list, correct in Excel, put `yes` in the verified column, then
   Data > **Import verified quantities** (model BUZZ, revision REV-A).
5. Approve the revision. If quantities are still unverified the app asks for a written reason (recorded as an override).
6. When more IDs are complete in the sheet, import again as `REV-B`: temporary parts (with no stock or purchase order) get their real
   ID automatically and the BOM lines follow. Nothing is duplicated.
7. Work on one vehicle at a time with the **Focus vehicle** selector (top of the menu).

What is not imported as a Part ID, on purpose: incomplete or placeholder IDs. A real Part ID cannot be changed once the part has stock, so
the app does not accept a number that you may still change.
