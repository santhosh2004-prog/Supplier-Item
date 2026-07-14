sap.ui.define(
  [
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/ui/model/Filter",
    "sap/ui/model/FilterOperator",
    "sap/m/MessageToast",
  ],
  function (Controller, JSONModel, Filter, FilterOperator, MessageToast) {
    "use strict";

    // ─── HELPERS ──────────────────────────────────────────────────────────────────

    var fnFmtAmt = function (v) {
      if (v === null || v === undefined) return "0.00";
      return parseFloat(v).toLocaleString("en-IN", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 3,
      });
    };

    var fnSum = function (arr, field) {
      return arr.reduce(function (a, o) {
        return a + (parseFloat(o[field]) || 0);
      }, 0);
    };

    var fnEmptyModel = function () {
      return {
        items: [],
        count: 0,
        displayAmt: "0.00",
        color: "Neutral",
        invAmt: 0,
        advAmt: 0,
        netAmt: 0,
        loaded: false,
      };
    };

    // ─── CONTROLLER ───────────────────────────────────────────────────────────────

    return Controller.extend("supplieropenitems.controller.Detail", {
      onInit: function () {
        // Two named models – one per tile group
        this.getView().setModel(new JSONModel(fnEmptyModel()), "reModel");
        this.getView().setModel(new JSONModel(fnEmptyModel()), "otherModel");

        this.getOwnerComponent()
          .getRouter()
          .getRoute("RouteDetail")
          .attachPatternMatched(this._onRoute, this);
      },

      // ─── ROUTE HANDLER ──────────────────────────────────────────────────────────

      _onRoute: function (oEvent) {
        var a = oEvent.getParameter("arguments");

        // Store all decoded route params for later use in tile-press navigation
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

        // Top-bar vendor name + meta line
        this.byId("vendorName").setText(this._p.lifnr + "  ·  " + this._p.name);
        this.byId("vendorMeta").setText(
          "Company: " +
            this._p.bukrs +
            "   |   Recon Acct: " +
            this._p.akont +
            "   |   Key Date: " +
            this._p.budat,
        );

        // Reset both tile models to empty before fetching
        this.getView().getModel("reModel").setData(fnEmptyModel());
        this.getView().getModel("otherModel").setData(fnEmptyModel());

        // Fetch OpenItemsSet and populate tile models
        this._fetch();
      },

      // ─── FETCH OpenItemsSet (once) ───────────────────────────────────────────────

      _fetch: function () {
        var oOData = this.getOwnerComponent().getModel();
        if (!oOData) {
          MessageToast.show("OData model not found.");
          return;
        }

        // Show busy on the tile strip while loading
        this.byId("tileStrip").setBusy(true);

        var p = this._p;
        // Pad reconciliation account to 10 chars as backend expects
        var sAkont = String(p.akont).padStart(10, "0");

        var aFilters = [
          new Filter("Bukrs", FilterOperator.EQ, p.bukrs),
          new Filter("Budat", FilterOperator.EQ, new Date(p.budat)),
          new Filter("Akont", FilterOperator.EQ, sAkont),
          new Filter("Lifnr", FilterOperator.EQ, p.lifnr),
        ];

        var that = this;
        oOData.read("/OpenItemsSet", {
          filters: aFilters,
          success: function (oData) {
            that.byId("tileStrip").setBusy(false);

            var all = oData.results || [];
            // Split: RE = PO invoices, everything else = Other
            var aRe = all.filter(function (o) {
              return o.Blart === "RE";
            });
            var aOth = all.filter(function (o) {
              return o.Blart !== "RE";
            });

            // ── Populate reModel ──────────────────────────────────────────
            var reNet = fnSum(aRe, "NetAmt");
            that
              .getView()
              .getModel("reModel")
              .setData({
                items: aRe,
                count: aRe.length,
                displayAmt: fnFmtAmt(Math.abs(reNet)),
                color: reNet < 0 ? "Critical" : "Good",
                invAmt: fnSum(aRe, "InvAmt"),
                advAmt: fnSum(aRe, "AdvAmt"),
                netAmt: reNet,
                loaded: true,
              });

            // ── Populate otherModel ───────────────────────────────────────
            var othNet = fnSum(aOth, "NetAmt");
            that
              .getView()
              .getModel("otherModel")
              .setData({
                items: aOth,
                count: aOth.length,
                displayAmt: fnFmtAmt(Math.abs(othNet)),
                color: othNet < 0 ? "Critical" : "Good",
                invAmt: fnSum(aOth, "InvAmt"),
                advAmt: fnSum(aOth, "AdvAmt"),
                netAmt: othNet,
                loaded: true,
              });
          },
          error: function () {
            that.byId("tileStrip").setBusy(false);
            MessageToast.show("Error loading open items.");
          },
        });
      },

      // ─── TILE PRESS HANDLERS ──────────────────────────────────────────────────────

      onReTilePress: function () {
        this._navToTable("RE");
      },

      onOtherTilePress: function () {
        this._navToTable("OTHER");
      },

      // Navigate to Table view, passing tile type + vendor params + group totals
      _navToTable: function (sTileType) {
        var sModelName = sTileType === "RE" ? "reModel" : "otherModel";
        var oData = this.getView().getModel(sModelName).getData();
        var p = this._p;

        // Pass items to Table controller via component property (avoids re-fetch)
        this.getOwnerComponent()._tableItems = oData.items || [];

        this.getOwnerComponent()
          .getRouter()
          .navTo("RouteTable", {
            tileType: encodeURIComponent(sTileType),
            lifnr: encodeURIComponent(p.lifnr),
            akont: encodeURIComponent(p.akont),
            name: encodeURIComponent(p.name),
            bukrs: encodeURIComponent(p.bukrs),
            budat: encodeURIComponent(p.budat),
            invAmt: encodeURIComponent(String(oData.invAmt)),
            advAmt: encodeURIComponent(String(oData.advAmt)),
            netAmt: encodeURIComponent(String(oData.netAmt)),
          });
      },

      // ─── NAV BACK  →  Main ──────────────────────────────────────────────────────

      onNavBack: function () {
        var h = sap.ui.core.routing.History.getInstance().getPreviousHash();
        if (h !== undefined) {
          window.history.go(-1);
        } else {
          this.getOwnerComponent().getRouter().navTo("RouteMain", {}, true);
        }
      },
    });
  },
);
