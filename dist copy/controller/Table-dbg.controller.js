sap.ui.define(
  [
    "sap/ui/core/mvc/Controller",
    "sap/m/Text",
    "sap/m/Label",
    "sap/m/Table",
    "sap/m/Column",
    "sap/m/ColumnListItem",
  ],
  function (Controller, Text, Label, Table, Column, ColumnListItem) {
    "use strict";

    // ─── HELPERS ──────────────────────────────────────────────────────────────────

    var fnFmtDate = function (v) {
      if (!v) return "";
      if (v instanceof Date) return v.toLocaleDateString("en-IN");
      var n = parseInt(String(v).replace(/\/Date\((\d+)\)\//, "$1"), 10);
      return isNaN(n) ? String(v) : new Date(n).toLocaleDateString("en-IN");
    };

    var fnFmtAmt = function (v) {
      if (v === null || v === undefined) return "0.00";
      return parseFloat(v).toLocaleString("en-IN", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 3,
      });
    };

    // ─── CONTROLLER ───────────────────────────────────────────────────────────────

    return Controller.extend("supplieropenitems.controller.Table", {
      onInit: function () {
        this.getOwnerComponent()
          .getRouter()
          .getRoute("RouteTable")
          .attachPatternMatched(this._onRoute, this);
      },

      // ─── ROUTE HANDLER ──────────────────────────────────────────────────────────

      _onRoute: function (oEvent) {
        var a = oEvent.getParameter("arguments");

        this._tileType = decodeURIComponent(a.tileType || "RE");

        // Store all params for back-navigation fallback
        this._p = {
          lifnr: decodeURIComponent(a.lifnr || ""),
          akont: decodeURIComponent(a.akont || ""),
          name: decodeURIComponent(a.name || ""),
          bukrs: decodeURIComponent(a.bukrs || ""),
          budat: decodeURIComponent(a.budat || ""),
          invAmt: decodeURIComponent(a.invAmt || ""),
          advAmt: decodeURIComponent(a.advAmt || ""),
          netAmt: decodeURIComponent(a.netAmt || ""),
        };

        var p = this._p;
        var bIsRE = this._tileType === "RE";

        // ── Top-bar vendor info ────────────────────────────────────────────────
        this.byId("tableVendorName").setText(p.lifnr + "  ·  " + p.name);
        this.byId("tableVendorMeta").setText(
          "Company: " +
            p.bukrs +
            "   |   Recon Acct: " +
            p.akont +
            "   |   Key Date: " +
            p.budat,
        );

        // ── Section title ──────────────────────────────────────────────────────
        this.byId("sectionTitle").setText(
          bIsRE
            ? "PO Invoices  —  Doc Type : RE"
            : "Other Items  —  All Non-RE Documents",
        );

        // ── Coloured badge pill ────────────────────────────────────────────────
        var sBadgeColor = bIsRE ? "#009688" : "#f59e0b";
        var sBadgeLabel = bIsRE ? "RE" : "OTHER";
        this.byId("tileTypeBadge").setContent(
          "<span class='typeBadge' style='background:" +
            sBadgeColor +
            ";'>" +
            sBadgeLabel +
            "</span>",
        );

        // ── Summary strip  (amounts are already formatted strings from route) ─
        this.byId("summaryText").setText(
          "Invoice : " +
            fnFmtAmt(p.invAmt) +
            "    |    Advance : " +
            fnFmtAmt(p.advAmt) +
            "    |    Net : " +
            fnFmtAmt(p.netAmt),
        );

        // ── Items passed from Detail controller via component property ─────────
        var aItems = this.getOwnerComponent()._tableItems || [];
        this._renderTable(aItems);
      },

      // ─── RENDER sap.m.Table ──────────────────────────────────────────────────────

      _renderTable: function (aItems) {
        var oBox = this.byId("tableContainer");
        oBox.removeAllItems();

        // Empty state
        if (!aItems || aItems.length === 0) {
          oBox.addItem(
            new Text({
              text: "No documents found for this category.",
            }).addStyleClass("emptyMsg"),
          );
          return;
        }

        var oTable = new Table({
          inset: false,
          growing: true,
          growingThreshold: 20,
          growingScrollToLoad: true,
          showSeparators: "All",
          sticky: ["ColumnHeaders"],
          columns: [
            new Column({
              header: new Label({ text: "Doc No" }),
              hAlign: "Begin",
            }),
            new Column({
              header: new Label({ text: "Doc Type" }),
              hAlign: "Begin",
            }),
            new Column({
              header: new Label({ text: "Posting Date" }),
              hAlign: "Begin",
            }),
            new Column({
              header: new Label({ text: "Doc Date" }),
              hAlign: "Begin",
            }),
            new Column({
              header: new Label({ text: "Spl G/L" }),
              hAlign: "Center",
            }),
            new Column({
              header: new Label({ text: "Clrng Doc" }),
              hAlign: "Begin",
            }),
            new Column({
              header: new Label({ text: "Invoice Amt" }),
              hAlign: "End",
            }),
            new Column({
              header: new Label({ text: "Advance Amt" }),
              hAlign: "End",
            }),
            new Column({
              header: new Label({ text: "Net Amt" }),
              hAlign: "End",
            }),
          ],
        }).addStyleClass("openItemsTable");

        aItems.forEach(function (o) {
          oTable.addItem(
            new ColumnListItem({
              cells: [
                new Text({ text: o.Belnr }),
                new Text({ text: o.Blart }),
                new Text({ text: fnFmtDate(o.Budat) }),
                new Text({ text: fnFmtDate(o.Bldat) }),
                new Text({ text: o.Umskz }),
                new Text({ text: o.Augbl }),
                new Text({ text: fnFmtAmt(o.InvAmt) }).addStyleClass("amtCell"),
                new Text({ text: fnFmtAmt(o.AdvAmt) }).addStyleClass("amtCell"),
                new Text({ text: fnFmtAmt(o.NetAmt) }).addStyleClass("amtCell"),
              ],
            }),
          );
        });

        oBox.addItem(oTable);
      },

      // ─── NAV BACK  →  Detail ────────────────────────────────────────────────────

      onNavBack: function () {
        var h = sap.ui.core.routing.History.getInstance().getPreviousHash();
        if (h !== undefined) {
          window.history.go(-1);
        } else {
          // Fallback: reconstruct Detail route with original vendor params
          var p = this._p;
          this.getOwnerComponent()
            .getRouter()
            .navTo(
              "RouteDetail",
              {
                lifnr: encodeURIComponent(p.lifnr),
                akont: encodeURIComponent(p.akont),
                name: encodeURIComponent(p.name),
                bukrs: encodeURIComponent(p.bukrs),
                budat: encodeURIComponent(p.budat),
                invAmt: encodeURIComponent(p.invAmt),
                advAmt: encodeURIComponent(p.advAmt),
                netAmt: encodeURIComponent(p.netAmt),
              },
              true,
            );
        }
      },
    });
  },
);
